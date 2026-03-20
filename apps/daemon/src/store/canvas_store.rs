use anyhow::ensure;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, EntityTrait, IntoActiveModel, PaginatorTrait, QueryFilter,
    QueryOrder, Set, TransactionTrait,
};
use serde::Serialize;
use uuid::Uuid;

use crate::canvas_selection::splice_utf16_selection;
use crate::db::entities::{canvas_revisions, canvases, threads};
use crate::db::{now_iso, Database};

pub fn normalize_canvas_title(title: &str) -> anyhow::Result<String> {
    let trimmed = title.trim();
    if trimmed.len() < 2 || trimmed.len() > 120 {
        anyhow::bail!("Canvas title must be 2-120 characters.");
    }
    Ok(trimmed.to_string())
}

pub fn normalize_canvas_kind(kind: &str) -> anyhow::Result<String> {
    let trimmed = kind.trim();
    if trimmed.is_empty() || trimmed.len() > 40 {
        anyhow::bail!("Canvas kind must be 1-40 characters.");
    }
    Ok(trimmed.to_string())
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CanvasDetail {
    pub id: String,
    pub thread_id: String,
    pub title: String,
    pub kind: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_by_user_message_index: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_updated_by_user_message_index: Option<usize>,
    pub created_at: String,
    pub updated_at: String,
    pub revision_count: usize,
    pub latest_revision_number: usize,
}

#[derive(Debug)]
pub struct SelectionReplaceInput<'a> {
    pub expected_current_content: &'a str,
    pub start_utf16: usize,
    pub end_utf16: usize,
    pub selected_text: &'a str,
    pub replacement: &'a str,
}

#[derive(Debug)]
pub enum CanvasContentUpdate<'a> {
    Full(&'a str),
    SelectionReplace(SelectionReplaceInput<'a>),
}

fn visible_user_message_index(
    user_message_index: Option<i64>,
    source_copilot_session_id: Option<&str>,
    current_thread_session_id: Option<&str>,
) -> Option<usize> {
    match (
        user_message_index,
        source_copilot_session_id,
        current_thread_session_id,
    ) {
        (Some(index), Some(source_session), Some(current_session))
            if source_session == current_session =>
        {
            Some(index as usize)
        }
        _ => None,
    }
}

fn to_canvas_detail(
    canvas: canvases::Model,
    revision_count: usize,
    latest_revision_number: usize,
    current_thread_session_id: Option<&str>,
) -> CanvasDetail {
    CanvasDetail {
        id: canvas.id,
        thread_id: canvas.thread_id,
        title: canvas.title,
        kind: canvas.kind,
        content: canvas.content,
        created_by_user_message_index: visible_user_message_index(
            canvas.created_by_user_message_index,
            canvas.created_by_copilot_session_id.as_deref(),
            current_thread_session_id,
        ),
        last_updated_by_user_message_index: visible_user_message_index(
            canvas.last_updated_by_user_message_index,
            canvas.last_updated_by_copilot_session_id.as_deref(),
            current_thread_session_id,
        ),
        created_at: canvas.created_at,
        updated_at: canvas.updated_at,
        revision_count,
        latest_revision_number,
    }
}

async fn canvas_revision_stats(db: &Database, canvas_id: &str) -> anyhow::Result<(usize, usize)> {
    let revisions = canvas_revisions::Entity::find()
        .filter(canvas_revisions::Column::CanvasId.eq(canvas_id.to_string()))
        .order_by_desc(canvas_revisions::Column::RevisionNumber)
        .all(db.connection())
        .await?;
    let revision_count = revisions.len();
    let latest_revision_number = revisions
        .first()
        .map(|revision| revision.revision_number as usize)
        .unwrap_or(0);
    Ok((revision_count, latest_revision_number))
}

async fn create_revision(
    txn: &sea_orm::DatabaseTransaction,
    canvas_id: &str,
    revision_number: usize,
    content: &str,
    source_user_message_index: Option<usize>,
    source_copilot_session_id: Option<&str>,
) -> anyhow::Result<()> {
    canvas_revisions::ActiveModel {
        id: Set(Uuid::new_v4().to_string()),
        canvas_id: Set(canvas_id.to_string()),
        revision_number: Set(revision_number as i64),
        content: Set(content.to_string()),
        created_at: Set(now_iso()),
        source_user_message_index: Set(source_user_message_index.map(|value| value as i64)),
        source_copilot_session_id: Set(source_copilot_session_id.map(str::to_string)),
    }
    .insert(txn)
    .await?;
    Ok(())
}

async fn current_thread_session_id(
    db: &Database,
    thread_id: &str,
) -> anyhow::Result<Option<String>> {
    Ok(threads::Entity::find_by_id(thread_id.to_string())
        .one(db.connection())
        .await?
        .and_then(|thread| thread.copilot_session_id))
}

pub async fn list_canvases(db: &Database, thread_id: &str) -> anyhow::Result<Vec<CanvasDetail>> {
    let current_thread_session_id = current_thread_session_id(db, thread_id).await?;
    let records = canvases::Entity::find()
        .filter(canvases::Column::ThreadId.eq(thread_id.to_string()))
        .order_by_desc(canvases::Column::UpdatedAt)
        .all(db.connection())
        .await?;

    let mut canvases_out = Vec::with_capacity(records.len());
    for canvas in records {
        let (revision_count, latest_revision_number) =
            canvas_revision_stats(db, &canvas.id).await?;
        canvases_out.push(to_canvas_detail(
            canvas,
            revision_count,
            latest_revision_number,
            current_thread_session_id.as_deref(),
        ));
    }
    Ok(canvases_out)
}

pub async fn create_canvas(
    db: &Database,
    thread_id: &str,
    title: &str,
    kind: &str,
    content: &str,
    source_user_message_index: Option<usize>,
    source_copilot_session_id: Option<&str>,
) -> anyhow::Result<CanvasDetail> {
    let txn = db.connection().begin().await?;
    let id = Uuid::new_v4().to_string();
    let now = now_iso();

    let inserted =
        canvases::ActiveModel {
            id: Set(id.clone()),
            thread_id: Set(thread_id.to_string()),
            title: Set(title.to_string()),
            kind: Set(kind.to_string()),
            content: Set(content.to_string()),
            created_by_user_message_index: Set(source_user_message_index.map(|value| value as i64)),
            created_by_copilot_session_id: Set(source_copilot_session_id.map(str::to_string)),
            last_updated_by_user_message_index: Set(
                source_user_message_index.map(|value| value as i64)
            ),
            last_updated_by_copilot_session_id: Set(source_copilot_session_id.map(str::to_string)),
            created_at: Set(now.clone()),
            updated_at: Set(now),
        }
        .insert(&txn)
        .await?;

    create_revision(
        &txn,
        &id,
        1,
        content,
        source_user_message_index,
        source_copilot_session_id,
    )
    .await?;
    txn.commit().await?;
    let current_thread_session_id = current_thread_session_id(db, thread_id).await?;

    Ok(to_canvas_detail(
        inserted,
        1,
        1,
        current_thread_session_id.as_deref(),
    ))
}

pub async fn update_canvas(
    db: &Database,
    thread_id: &str,
    canvas_id: &str,
    title: Option<&str>,
    content: Option<CanvasContentUpdate<'_>>,
    source_user_message_index: Option<usize>,
    source_copilot_session_id: Option<&str>,
) -> anyhow::Result<Option<CanvasDetail>> {
    let Some(existing) = canvases::Entity::find_by_id(canvas_id.to_string())
        .filter(canvases::Column::ThreadId.eq(thread_id.to_string()))
        .one(db.connection())
        .await?
    else {
        return Ok(None);
    };

    let title_changed = title.is_some_and(|next| next != existing.title);
    let next_content = match content {
        Some(CanvasContentUpdate::Full(content)) => Some(content.to_string()),
        Some(CanvasContentUpdate::SelectionReplace(selection)) => {
            ensure!(
                existing.content == selection.expected_current_content,
                "Canvas content changed before the selection edit could be applied. Reload the canvas and retry."
            );
            Some(splice_utf16_selection(
                &existing.content,
                selection.start_utf16,
                selection.end_utf16,
                selection.selected_text,
                selection.replacement,
            )?)
        }
        None => None,
    };
    let content_changed = next_content
        .as_ref()
        .is_some_and(|next| next != &existing.content);
    let next_content_ref = next_content.as_deref().unwrap_or(&existing.content);

    let txn = db.connection().begin().await?;
    let mut active = existing.clone().into_active_model();
    if let Some(title) = title {
        active.title = Set(title.to_string());
    }
    if let Some(content) = next_content.as_deref() {
        active.content = Set(content.to_string());
    }
    if source_user_message_index.is_some() {
        active.last_updated_by_user_message_index =
            Set(source_user_message_index.map(|value| value as i64));
        active.last_updated_by_copilot_session_id =
            Set(source_copilot_session_id.map(str::to_string));
    }
    if title_changed || content_changed || source_user_message_index.is_some() {
        active.updated_at = Set(now_iso());
    }
    let updated = active.update(&txn).await?;

    let mut latest_revision_number = canvas_revisions::Entity::find()
        .filter(canvas_revisions::Column::CanvasId.eq(canvas_id.to_string()))
        .order_by_desc(canvas_revisions::Column::RevisionNumber)
        .one(&txn)
        .await?
        .map(|revision| revision.revision_number as usize)
        .unwrap_or(0);

    if content_changed {
        latest_revision_number += 1;
        create_revision(
            &txn,
            canvas_id,
            latest_revision_number,
            next_content_ref,
            source_user_message_index,
            source_copilot_session_id,
        )
        .await?;
    }

    let revision_count = canvas_revisions::Entity::find()
        .filter(canvas_revisions::Column::CanvasId.eq(canvas_id.to_string()))
        .count(&txn)
        .await? as usize;

    txn.commit().await?;
    let current_thread_session_id = current_thread_session_id(db, thread_id).await?;

    Ok(Some(to_canvas_detail(
        updated,
        revision_count,
        latest_revision_number,
        current_thread_session_id.as_deref(),
    )))
}

#[cfg(test)]
mod tests {
    use super::{
        create_canvas, list_canvases, update_canvas, CanvasContentUpdate, SelectionReplaceInput,
    };

    fn utf16_range_for(content: &str, selected: &str) -> (usize, usize) {
        let byte_start = content
            .find(selected)
            .expect("selected text should exist in the content");
        let start = content[..byte_start].encode_utf16().count();
        let end = start + selected.encode_utf16().count();
        (start, end)
    }

    async fn test_thread() -> (
        tempfile::TempDir,
        crate::config::Config,
        crate::db::Database,
        crate::store::thread_store::ThreadSummary,
    ) {
        let temp = tempfile::tempdir().unwrap();
        let config = crate::config::test_config(temp.path());
        let db = crate::db::Database::open(&config).await.unwrap();
        crate::store::auth_store::create_local_session(&db, &config)
            .await
            .unwrap();
        let thread = crate::store::thread_store::create_thread(
            &db,
            &config,
            &config.daemon_owner_id,
            &config.default_model,
            None,
            Some("Canvas test"),
            None,
            None,
        )
        .await
        .unwrap()
        .expect("thread should be created");
        (temp, config, db, thread)
    }

    #[tokio::test]
    async fn list_canvases_hides_message_indices_after_a_session_reset() {
        let (_temp, _config, db, thread) = test_thread().await;

        crate::store::thread_store::update_thread_session(&db, &thread.id, "session-old")
            .await
            .unwrap();
        let canvas = create_canvas(
            &db,
            &thread.id,
            "Session scoped canvas",
            "document",
            "draft",
            Some(0),
            Some("session-old"),
        )
        .await
        .unwrap();
        assert_eq!(canvas.created_by_user_message_index, Some(0));
        assert_eq!(canvas.last_updated_by_user_message_index, Some(0));

        crate::store::thread_store::update_thread_session(&db, &thread.id, "session-new")
            .await
            .unwrap();
        let canvases = list_canvases(&db, &thread.id).await.unwrap();
        assert_eq!(canvases.len(), 1);
        assert_eq!(canvases[0].created_by_user_message_index, None);
        assert_eq!(canvases[0].last_updated_by_user_message_index, None);

        let updated = update_canvas(
            &db,
            &thread.id,
            &canvas.id,
            None,
            Some(CanvasContentUpdate::Full("revised draft")),
            Some(0),
            Some("session-new"),
        )
        .await
        .unwrap()
        .expect("canvas should exist");
        assert_eq!(updated.created_by_user_message_index, None);
        assert_eq!(updated.last_updated_by_user_message_index, Some(0));
    }

    #[tokio::test]
    async fn selection_replace_requires_the_current_document_and_utf16_selection_match() {
        let (_temp, _config, db, thread) = test_thread().await;

        crate::store::thread_store::update_thread_session(&db, &thread.id, "session-current")
            .await
            .unwrap();
        let initial_content = "a🙂b🚀c";
        let canvas = create_canvas(
            &db,
            &thread.id,
            "Unicode selection",
            "document",
            initial_content,
            Some(0),
            Some("session-current"),
        )
        .await
        .unwrap();
        let (start_utf16, end_utf16) = utf16_range_for(initial_content, "b🚀");

        let mismatched_selection_error = update_canvas(
            &db,
            &thread.id,
            &canvas.id,
            None,
            Some(CanvasContentUpdate::SelectionReplace(
                SelectionReplaceInput {
                    expected_current_content: initial_content,
                    start_utf16,
                    end_utf16,
                    selected_text: "b✨",
                    replacement: "X",
                },
            )),
            Some(1),
            Some("session-current"),
        )
        .await
        .unwrap_err();
        assert!(mismatched_selection_error
            .to_string()
            .contains("selected text no longer matches"));

        let updated = update_canvas(
            &db,
            &thread.id,
            &canvas.id,
            None,
            Some(CanvasContentUpdate::SelectionReplace(
                SelectionReplaceInput {
                    expected_current_content: initial_content,
                    start_utf16,
                    end_utf16,
                    selected_text: "b🚀",
                    replacement: "X",
                },
            )),
            Some(1),
            Some("session-current"),
        )
        .await
        .unwrap()
        .expect("canvas should exist");
        assert_eq!(updated.content, "a🙂Xc");

        let stale_document_error = update_canvas(
            &db,
            &thread.id,
            &canvas.id,
            None,
            Some(CanvasContentUpdate::SelectionReplace(
                SelectionReplaceInput {
                    expected_current_content: initial_content,
                    start_utf16,
                    end_utf16,
                    selected_text: "b🚀",
                    replacement: "✨",
                },
            )),
            Some(2),
            Some("session-current"),
        )
        .await
        .unwrap_err();
        assert!(stale_document_error
            .to_string()
            .contains("Canvas content changed before the selection edit could be applied"));
    }
}

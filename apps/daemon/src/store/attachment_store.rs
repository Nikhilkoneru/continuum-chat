use std::collections::HashMap;

use sea_orm::{
    ActiveModelTrait, ColumnTrait, Condition, EntityTrait, QueryFilter, QueryOrder, Set,
    TransactionTrait,
};
use serde::Serialize;
use uuid::Uuid;

use crate::db::entities::{attachments, message_attachment_set_items, message_attachment_sets};
use crate::db::{now_iso, Database};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentSummary {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub size: i64,
    pub kind: String,
    pub uploaded_at: String,
}

#[derive(Clone)]
pub struct MessageAttachmentSet {
    pub user_message_index: usize,
    pub attachments: Vec<AttachmentSummary>,
}

#[derive(Clone)]
pub struct AttachmentRecord {
    pub name: String,
    pub mime_type: String,
    pub file_path: String,
}

fn classify_kind(mime_type: &str) -> &str {
    if mime_type.starts_with("image/") {
        "image"
    } else if mime_type == "application/pdf" || mime_type.starts_with("text/") {
        "document"
    } else if mime_type.starts_with("audio/") {
        "audio"
    } else if mime_type.starts_with("video/") {
        "video"
    } else {
        "other"
    }
}

pub async fn save_attachment(
    db: &Database,
    media_root: &std::path::Path,
    owner_id: &str,
    thread_id: Option<&str>,
    original_name: &str,
    mime_type: &str,
    bytes: &[u8],
) -> anyhow::Result<AttachmentSummary> {
    let id = Uuid::new_v4().to_string();
    let now = now_iso();
    let kind = classify_kind(mime_type);
    let ext = original_name
        .rsplit('.')
        .next()
        .filter(|e| e.len() <= 10)
        .unwrap_or("bin");
    let file_name = format!("{id}.{ext}");
    let file_path = media_root.join(&file_name);
    std::fs::write(&file_path, bytes)?;

    let insert_result = attachments::ActiveModel {
        id: Set(id.clone()),
        github_user_id: Set(owner_id.to_string()),
        thread_id: Set(thread_id.map(str::to_string)),
        name: Set(original_name.to_string()),
        mime_type: Set(mime_type.to_string()),
        size: Set(bytes.len() as i64),
        kind: Set(kind.to_string()),
        file_path: Set(file_path.to_string_lossy().to_string()),
        pdf_context_file_path: Set(None),
        pdf_extraction: Set(None),
        pdf_page_count: Set(None),
        pdf_title: Set(None),
        created_at: Set(now.clone()),
        updated_at: Set(now.clone()),
        uploaded_at: Set(now.clone()),
    }
    .insert(db.connection())
    .await;

    if let Err(error) = insert_result {
        let _ = std::fs::remove_file(&file_path);
        return Err(error.into());
    }

    Ok(AttachmentSummary {
        id,
        name: original_name.to_string(),
        mime_type: mime_type.to_string(),
        size: bytes.len() as i64,
        kind: kind.to_string(),
        uploaded_at: now,
    })
}

pub async fn get_attachments_by_ids(
    db: &Database,
    owner_id: &str,
    thread_id: Option<&str>,
    attachment_ids: &[String],
) -> anyhow::Result<Vec<AttachmentRecord>> {
    if attachment_ids.is_empty() {
        return Ok(Vec::new());
    }

    let mut query = attachments::Entity::find()
        .filter(attachments::Column::Id.is_in(attachment_ids.to_vec()))
        .filter(attachments::Column::GithubUserId.eq(owner_id.to_string()));

    if let Some(thread_id) = thread_id {
        query = query.filter(
            Condition::any()
                .add(attachments::Column::ThreadId.is_null())
                .add(attachments::Column::ThreadId.eq(thread_id.to_string())),
        );
    }

    let records = query.all(db.connection()).await?;
    let records_by_id = records
        .into_iter()
        .map(|attachment| {
            (
                attachment.id,
                AttachmentRecord {
                    name: attachment.name,
                    mime_type: attachment.mime_type,
                    file_path: attachment.file_path,
                },
            )
        })
        .collect::<HashMap<_, _>>();

    Ok(attachment_ids
        .iter()
        .filter_map(|attachment_id| records_by_id.get(attachment_id).cloned())
        .collect())
}

pub async fn save_message_attachments(
    db: &Database,
    thread_id: &str,
    user_message_index: usize,
    attachment_ids: &[String],
) -> anyhow::Result<()> {
    if attachment_ids.is_empty() {
        return Ok(());
    }

    let txn = db.connection().begin().await?;
    message_attachment_sets::Entity::delete_many()
        .filter(message_attachment_sets::Column::ThreadId.eq(thread_id.to_string()))
        .filter(message_attachment_sets::Column::UserMessageIndex.eq(user_message_index as i64))
        .exec(&txn)
        .await?;

    let set_id = Uuid::new_v4().to_string();
    let now = now_iso();
    message_attachment_sets::ActiveModel {
        id: Set(set_id.clone()),
        thread_id: Set(thread_id.to_string()),
        user_message_index: Set(user_message_index as i64),
        created_at: Set(now),
    }
    .insert(&txn)
    .await?;

    for (position, attachment_id) in attachment_ids.iter().enumerate() {
        message_attachment_set_items::ActiveModel {
            message_attachment_set_id: Set(set_id.clone()),
            attachment_id: Set(attachment_id.clone()),
            position: Set(position as i64),
        }
        .insert(&txn)
        .await?;
    }

    txn.commit().await?;
    Ok(())
}

pub async fn list_message_attachments(
    db: &Database,
    thread_id: &str,
) -> anyhow::Result<Vec<MessageAttachmentSet>> {
    let sets = message_attachment_sets::Entity::find()
        .filter(message_attachment_sets::Column::ThreadId.eq(thread_id.to_string()))
        .order_by_asc(message_attachment_sets::Column::UserMessageIndex)
        .order_by_asc(message_attachment_sets::Column::CreatedAt)
        .all(db.connection())
        .await?;

    let mut result = Vec::with_capacity(sets.len());
    for set in sets {
        let items = message_attachment_set_items::Entity::find()
            .filter(
                message_attachment_set_items::Column::MessageAttachmentSetId.eq(set.id.clone()),
            )
            .order_by_asc(message_attachment_set_items::Column::Position)
            .all(db.connection())
            .await?;

        let attachment_ids = items
            .iter()
            .map(|item| item.attachment_id.clone())
            .collect::<Vec<_>>();
        let attachments = attachments::Entity::find()
            .filter(attachments::Column::Id.is_in(attachment_ids.clone()))
            .all(db.connection())
            .await?;
        let attachments_by_id = attachments
            .into_iter()
            .map(|attachment| {
                let attachment_id = attachment.id.clone();
                (
                    attachment_id,
                    AttachmentSummary {
                        id: attachment.id,
                        name: attachment.name,
                        mime_type: attachment.mime_type,
                        size: attachment.size,
                        kind: attachment.kind,
                        uploaded_at: attachment.uploaded_at,
                    },
                )
            })
            .collect::<HashMap<_, _>>();

        result.push(MessageAttachmentSet {
            user_message_index: set.user_message_index as usize,
            attachments: attachment_ids
                .iter()
                .filter_map(|attachment_id| attachments_by_id.get(attachment_id).cloned())
                .collect(),
        });
    }

    Ok(result)
}

use sea_orm::{ActiveModelTrait, EntityTrait, IntoActiveModel, Set};
use serde::Serialize;

use crate::db::entities::app_preferences;
use crate::db::{now_iso, Database};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CopilotPreferences {
    pub approval_mode: String,
}

pub async fn get_preferences(db: &Database) -> anyhow::Result<CopilotPreferences> {
    let mode = app_preferences::Entity::find_by_id("copilot_approval_mode".to_string())
        .one(db.connection())
        .await?
        .map(|model| model.value)
        .unwrap_or_else(|| "approve-all".to_string());

    Ok(CopilotPreferences {
        approval_mode: mode,
    })
}

pub async fn set_approval_mode(db: &Database, mode: &str) -> anyhow::Result<CopilotPreferences> {
    if let Some(existing) = app_preferences::Entity::find_by_id("copilot_approval_mode".to_string())
        .one(db.connection())
        .await?
    {
        let mut active = existing.into_active_model();
        active.value = Set(mode.to_string());
        active.updated_at = Set(now_iso());
        active.update(db.connection()).await?;
    } else {
        app_preferences::ActiveModel {
            key: Set("copilot_approval_mode".to_string()),
            value: Set(mode.to_string()),
            updated_at: Set(now_iso()),
        }
        .insert(db.connection())
        .await?;
    }

    Ok(CopilotPreferences {
        approval_mode: mode.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn defaults_and_updates_preferences() {
        let temp = tempfile::tempdir().unwrap();
        let config = crate::config::test_config(temp.path());
        let db = crate::db::Database::open(&config).await.unwrap();

        let initial = get_preferences(&db).await.unwrap();
        assert_eq!(initial.approval_mode, "approve-all");

        set_approval_mode(&db, "safer-defaults").await.unwrap();
        let updated = get_preferences(&db).await.unwrap();
        assert_eq!(updated.approval_mode, "safer-defaults");
    }
}

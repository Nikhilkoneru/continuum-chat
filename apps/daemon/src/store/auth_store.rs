use sea_orm::{
    ActiveModelTrait, ColumnTrait, EntityTrait, IntoActiveModel, QueryFilter, QueryOrder, Set,
    TransactionTrait,
};
use serde::Serialize;
use uuid::Uuid;

use crate::config::Config;
use crate::db::entities::{app_sessions, device_auth_flows, oauth_states, users};
use crate::db::{now_iso, Database};

const SESSION_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1000;
const DEVICE_AUTH_TTL_MS: i64 = 15 * 60 * 1000;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UserSession {
    pub session_token: String,
    pub user: AppSessionUser,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppSessionUser {
    pub id: String,
    pub login: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceAuthStart {
    pub flow_id: String,
    pub user_code: String,
    pub verification_uri: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verification_uri_complete: Option<String>,
    pub expires_at: String,
    pub interval: i64,
}

#[derive(Serialize)]
#[serde(untagged)]
pub enum DeviceAuthPoll {
    Pending(DeviceAuthPollPending),
    Complete {
        status: String,
        session: UserSession,
    },
    Failed {
        status: String,
        error: String,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceAuthPollPending {
    pub status: String,
    pub flow_id: String,
    pub user_code: String,
    pub verification_uri: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verification_uri_complete: Option<String>,
    pub expires_at: String,
    pub interval: i64,
}

pub async fn prune(db: &Database) -> anyhow::Result<()> {
    let now = now_iso();
    oauth_states::Entity::delete_many()
        .filter(oauth_states::Column::ExpiresAt.lt(now.clone()))
        .exec(db.connection())
        .await?;
    app_sessions::Entity::delete_many()
        .filter(app_sessions::Column::ExpiresAt.lt(now.clone()))
        .exec(db.connection())
        .await?;
    let expired_flows = device_auth_flows::Entity::find()
        .filter(device_auth_flows::Column::Status.eq("pending"))
        .filter(device_auth_flows::Column::ExpiresAt.lt(now))
        .all(db.connection())
        .await?;
    for flow in expired_flows {
        let mut active = flow.into_active_model();
        active.status = Set("expired".to_string());
        active.error = Set(Some(
            "GitHub device code expired. Start sign-in again.".to_string(),
        ));
        active.update(db.connection()).await?;
    }

    let cutoff = (chrono::Utc::now() - chrono::Duration::milliseconds(DEVICE_AUTH_TTL_MS))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    device_auth_flows::Entity::delete_many()
        .filter(device_auth_flows::Column::CreatedAt.lt(cutoff))
        .exec(db.connection())
        .await?;

    Ok(())
}

async fn find_existing_owner_id(db: &Database, config: &Config) -> anyhow::Result<String> {
    let existing = users::Entity::find()
        .order_by_desc(users::Column::UpdatedAt)
        .order_by_desc(users::Column::CreatedAt)
        .one(db.connection())
        .await?;

    Ok(existing
        .map(|user| user.github_user_id)
        .unwrap_or_else(|| config.daemon_owner_id.clone()))
}

pub async fn create_app_session(
    db: &Database,
    config: &Config,
    github_access_token: &str,
    profile: Option<(&str, Option<&str>, Option<&str>)>,
) -> anyhow::Result<UserSession> {
    prune(db).await?;

    let now = now_iso();
    let session_token = Uuid::new_v4().to_string();
    let owner_id = find_existing_owner_id(db, config).await?;
    let (login, name, avatar_url) = profile.unwrap_or((
        &config.daemon_owner_login,
        Some(config.daemon_owner_name.as_str()),
        None,
    ));

    let txn = db.connection().begin().await?;
    if let Some(existing) = users::Entity::find_by_id(owner_id.clone()).one(&txn).await? {
        let mut active = existing.into_active_model();
        active.login = Set(login.to_string());
        active.name = Set(name.map(str::to_string));
        active.avatar_url = Set(avatar_url.map(str::to_string));
        active.updated_at = Set(now.clone());
        active.update(&txn).await?;
    } else {
        users::ActiveModel {
            github_user_id: Set(owner_id.clone()),
            login: Set(login.to_string()),
            name: Set(name.map(str::to_string)),
            avatar_url: Set(avatar_url.map(str::to_string)),
            created_at: Set(now.clone()),
            updated_at: Set(now.clone()),
        }
        .insert(&txn)
        .await?;
    }

    let expires_at = (chrono::Utc::now() + chrono::Duration::milliseconds(SESSION_TTL_MS))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    app_sessions::ActiveModel {
        session_token: Set(session_token.clone()),
        github_user_id: Set(owner_id.clone()),
        github_access_token: Set(github_access_token.to_string()),
        auth_mode: Set(config.app_auth_mode.clone()),
        created_at: Set(now),
        expires_at: Set(expires_at),
    }
    .insert(&txn)
    .await?;

    txn.commit().await?;

    Ok(UserSession {
        session_token,
        user: AppSessionUser {
            id: owner_id,
            login: login.to_string(),
            name: name.map(str::to_string),
            avatar_url: avatar_url.map(str::to_string),
        },
    })
}

pub async fn create_local_session(db: &Database, config: &Config) -> anyhow::Result<UserSession> {
    create_app_session(db, config, "", None).await
}

pub async fn destroy_session(db: &Database, token: &str) -> anyhow::Result<()> {
    app_sessions::Entity::delete_by_id(token.to_string())
        .exec(db.connection())
        .await?;
    Ok(())
}

pub async fn create_device_auth(
    db: &Database,
    device_code: &str,
    user_code: &str,
    verification_uri: &str,
    verification_uri_complete: Option<&str>,
    expires_in: i64,
    interval: i64,
) -> anyhow::Result<DeviceAuthStart> {
    prune(db).await?;

    let flow_id = Uuid::new_v4().to_string();
    let now = now_iso();
    let expires_at = (chrono::Utc::now() + chrono::Duration::seconds(expires_in))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let next_poll_at = (chrono::Utc::now() + chrono::Duration::seconds(interval))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    device_auth_flows::ActiveModel {
        flow_id: Set(flow_id.clone()),
        device_code: Set(device_code.to_string()),
        user_code: Set(user_code.to_string()),
        verification_uri: Set(verification_uri.to_string()),
        verification_uri_complete: Set(verification_uri_complete.map(str::to_string)),
        expires_at: Set(expires_at.clone()),
        interval_seconds: Set(interval),
        next_poll_at: Set(next_poll_at),
        status: Set("pending".to_string()),
        session_token: Set(None),
        error: Set(None),
        created_at: Set(now),
    }
    .insert(db.connection())
    .await?;

    Ok(DeviceAuthStart {
        flow_id,
        user_code: user_code.to_string(),
        verification_uri: verification_uri.to_string(),
        verification_uri_complete: verification_uri_complete.map(str::to_string),
        expires_at,
        interval,
    })
}

pub struct DeviceAuthRecord {
    pub flow_id: String,
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: Option<String>,
    pub expires_at: String,
    pub interval: i64,
    pub next_poll_at: String,
    pub status: String,
    pub session_token: Option<String>,
    pub error: Option<String>,
}

pub async fn get_device_auth(
    db: &Database,
    flow_id: &str,
) -> anyhow::Result<Option<DeviceAuthRecord>> {
    prune(db).await?;

    let record = device_auth_flows::Entity::find_by_id(flow_id.to_string())
        .one(db.connection())
        .await?;

    Ok(record.map(|record| DeviceAuthRecord {
        flow_id: record.flow_id,
        device_code: record.device_code,
        user_code: record.user_code,
        verification_uri: record.verification_uri,
        verification_uri_complete: record.verification_uri_complete,
        expires_at: record.expires_at,
        interval: record.interval_seconds,
        next_poll_at: record.next_poll_at,
        status: record.status,
        session_token: record.session_token,
        error: record.error,
    }))
}

pub async fn schedule_device_poll(
    db: &Database,
    flow_id: &str,
    interval: Option<i64>,
) -> anyhow::Result<()> {
    let actual_interval = interval.unwrap_or(5);
    let next_poll_at = (chrono::Utc::now() + chrono::Duration::seconds(actual_interval))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    if let Some(record) = device_auth_flows::Entity::find_by_id(flow_id.to_string())
        .one(db.connection())
        .await?
    {
        let mut active = record.into_active_model();
        active.interval_seconds = Set(actual_interval);
        active.next_poll_at = Set(next_poll_at);
        active.update(db.connection()).await?;
    }

    Ok(())
}

pub async fn complete_device_auth(
    db: &Database,
    flow_id: &str,
    session_token: &str,
) -> anyhow::Result<()> {
    if let Some(record) = device_auth_flows::Entity::find_by_id(flow_id.to_string())
        .one(db.connection())
        .await?
    {
        let mut active = record.into_active_model();
        active.status = Set("complete".to_string());
        active.session_token = Set(Some(session_token.to_string()));
        active.error = Set(None);
        active.update(db.connection()).await?;
    }

    Ok(())
}

pub async fn fail_device_auth(
    db: &Database,
    flow_id: &str,
    status: &str,
    error: &str,
) -> anyhow::Result<()> {
    if let Some(record) = device_auth_flows::Entity::find_by_id(flow_id.to_string())
        .one(db.connection())
        .await?
    {
        let mut active = record.into_active_model();
        active.status = Set(status.to_string());
        active.error = Set(Some(error.to_string()));
        active.update(db.connection()).await?;
    }

    Ok(())
}

pub async fn get_device_auth_poll_payload(
    db: &Database,
    config: &Config,
    flow_id: &str,
) -> anyhow::Result<Option<DeviceAuthPoll>> {
    let Some(record) = get_device_auth(db, flow_id).await? else {
        return Ok(None);
    };

    if record.status == "complete" {
        if let Some(ref token) = record.session_token {
            if let Some(session) = crate::auth_middleware::get_session(db, config, token).await? {
                return Ok(Some(DeviceAuthPoll::Complete {
                    status: "complete".into(),
                    session: UserSession {
                        session_token: session.session_token,
                        user: AppSessionUser {
                            id: session.user_id,
                            login: session.login,
                            name: session.name,
                            avatar_url: session.avatar_url,
                        },
                    },
                }));
            }
        }
    }

    if record.status == "pending" {
        return Ok(Some(DeviceAuthPoll::Pending(DeviceAuthPollPending {
            status: "pending".into(),
            flow_id: record.flow_id,
            user_code: record.user_code,
            verification_uri: record.verification_uri,
            verification_uri_complete: record.verification_uri_complete,
            expires_at: record.expires_at,
            interval: record.interval,
        })));
    }

    Ok(Some(DeviceAuthPoll::Failed {
        status: if record.status == "denied" {
            "denied".into()
        } else {
            "expired".into()
        },
        error: record
            .error
            .unwrap_or_else(|| "GitHub device authorization ended unexpectedly.".into()),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn device_auth_payload_transitions_from_pending_to_complete() {
        let temp = tempfile::tempdir().unwrap();
        let config = crate::config::test_config(temp.path());
        let db = crate::db::Database::open(&config).await.unwrap();

        let flow = create_device_auth(
            &db,
            "device-code",
            "user-code",
            "https://github.com/login/device",
            None,
            900,
            5,
        )
        .await
        .unwrap();

        let pending = get_device_auth_poll_payload(&db, &config, &flow.flow_id)
            .await
            .unwrap()
            .expect("pending payload");
        assert!(matches!(pending, DeviceAuthPoll::Pending(_)));

        let session = create_local_session(&db, &config).await.unwrap();
        complete_device_auth(&db, &flow.flow_id, &session.session_token)
            .await
            .unwrap();

        let complete = get_device_auth_poll_payload(&db, &config, &flow.flow_id)
            .await
            .unwrap()
            .expect("complete payload");
        assert!(matches!(complete, DeviceAuthPoll::Complete { .. }));
    }
}

use axum::http::HeaderMap;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};

use crate::config::Config;
use crate::db::entities::{app_sessions, users};
use crate::db::Database;

pub struct AuthSession {
    pub session_token: String,
    pub user_id: String,
    pub login: String,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
}

pub fn extract_bearer_token(headers: &HeaderMap) -> Option<String> {
    if let Some(auth) = headers.get("authorization").and_then(|v| v.to_str().ok()) {
        if let Some(token) = auth.strip_prefix("Bearer ") {
            return Some(token.to_string());
        }
    }
    if let Some(token) = headers.get("x-session-token").and_then(|v| v.to_str().ok()) {
        return Some(token.to_string());
    }
    None
}

pub fn check_service_access(headers: &HeaderMap, config: &Config) -> bool {
    let Some(ref required) = config.service_access_token else {
        return true;
    };
    let provided = headers
        .get("x-service-access-token")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    provided == required
}

pub async fn get_session(
    db: &Database,
    config: &Config,
    token: &str,
) -> anyhow::Result<Option<AuthSession>> {
    let now = crate::db::now_iso();
    let Some(session) = app_sessions::Entity::find_by_id(token.to_string())
        .filter(app_sessions::Column::ExpiresAt.gte(now))
        .filter(app_sessions::Column::AuthMode.eq(config.app_auth_mode.clone()))
        .one(db.connection())
        .await?
    else {
        return Ok(None);
    };

    let Some(user) = users::Entity::find_by_id(session.github_user_id.clone())
        .one(db.connection())
        .await?
    else {
        return Ok(None);
    };

    Ok(Some(AuthSession {
        session_token: session.session_token,
        user_id: user.github_user_id,
        login: user.login,
        name: user.name,
        avatar_url: user.avatar_url,
    }))
}

pub async fn require_session(
    headers: &HeaderMap,
    db: &Database,
    config: &Config,
) -> Result<AuthSession, crate::error::AppError> {
    if !check_service_access(headers, config) {
        return Err(crate::error::AppError::Unauthorized(
            "Missing or invalid service access token.".into(),
        ));
    }
    let token = extract_bearer_token(headers).ok_or_else(|| {
        if config.app_auth_mode == "local" {
            crate::error::AppError::Unauthorized(
                "Your local daemon session is missing. Start a new local session and try again."
                    .into(),
            )
        } else {
            crate::error::AppError::Unauthorized("You must sign in to use this product.".into())
        }
    })?;
    get_session(db, config, &token).await?.ok_or_else(|| {
        crate::error::AppError::Unauthorized("Your session expired. Please sign in again.".into())
    })
}

#[cfg(test)]
mod tests {
    use axum::http::HeaderValue;

    use super::*;

    #[test]
    fn extracts_bearer_and_session_tokens() {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", HeaderValue::from_static("Bearer abc123"));
        assert_eq!(extract_bearer_token(&headers).as_deref(), Some("abc123"));

        headers.remove("authorization");
        headers.insert("x-session-token", HeaderValue::from_static("fallback-token"));
        assert_eq!(
            extract_bearer_token(&headers).as_deref(),
            Some("fallback-token")
        );
    }

    #[test]
    fn validates_service_access_token() {
        let config = crate::config::test_config(std::path::Path::new("/tmp"));
        let mut headers = HeaderMap::new();
        headers.insert("x-service-access-token", HeaderValue::from_static("service-token"));
        assert!(check_service_access(&headers, &config));

        headers.insert("x-service-access-token", HeaderValue::from_static("wrong"));
        assert!(!check_service_access(&headers, &config));
    }

    #[tokio::test]
    async fn loads_created_local_session() {
        let temp = tempfile::tempdir().unwrap();
        let config = crate::config::test_config(temp.path());
        let db = crate::db::Database::open(&config).await.unwrap();

        let session = crate::store::auth_store::create_local_session(&db, &config)
            .await
            .unwrap();
        let loaded = get_session(&db, &config, &session.session_token)
            .await
            .unwrap()
            .expect("session should load");

        assert_eq!(loaded.user_id, config.daemon_owner_id);
        assert_eq!(loaded.login, config.daemon_owner_login);
    }
}

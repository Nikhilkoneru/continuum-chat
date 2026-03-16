use sea_orm::ConnectionTrait;
use sea_orm_migration::prelude::*;

const INITIAL_SCHEMA_SQL: &str = include_str!("../../sql/schema.sql");

#[derive(DeriveMigrationName)]
pub struct M20260316_000001InitialSchema;

#[async_trait::async_trait]
impl MigrationTrait for M20260316_000001InitialSchema {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(INITIAL_SCHEMA_SQL)
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
                DROP TABLE IF EXISTS app_preferences;
                DROP TABLE IF EXISTS message_attachment_set_items;
                DROP TABLE IF EXISTS message_attachment_sets;
                DROP TABLE IF EXISTS attachments;
                DROP TABLE IF EXISTS threads;
                DROP TABLE IF EXISTS projects;
                DROP TABLE IF EXISTS device_auth_flows;
                DROP TABLE IF EXISTS oauth_states;
                DROP TABLE IF EXISTS app_sessions;
                DROP TABLE IF EXISTS users;
                "#,
            )
            .await?;
        Ok(())
    }
}

pub struct Migrator;

#[async_trait::async_trait]
impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![Box::new(M20260316_000001InitialSchema)]
    }
}

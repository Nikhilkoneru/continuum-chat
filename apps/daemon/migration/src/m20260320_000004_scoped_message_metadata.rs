use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        if !manager
            .has_column("message_attachment_sets", "copilot_session_id")
            .await?
        {
            manager
                .alter_table(
                    Table::alter()
                        .table(Alias::new("message_attachment_sets"))
                        .add_column(ColumnDef::new(Alias::new("copilot_session_id")).string())
                        .to_owned(),
                )
                .await?;
        }

        if !manager
            .has_column("canvases", "created_by_copilot_session_id")
            .await?
        {
            manager
                .alter_table(
                    Table::alter()
                        .table(Alias::new("canvases"))
                        .add_column(
                            ColumnDef::new(Alias::new("created_by_copilot_session_id")).string(),
                        )
                        .to_owned(),
                )
                .await?;
        }

        if !manager
            .has_column("canvases", "last_updated_by_copilot_session_id")
            .await?
        {
            manager
                .alter_table(
                    Table::alter()
                        .table(Alias::new("canvases"))
                        .add_column(
                            ColumnDef::new(Alias::new("last_updated_by_copilot_session_id"))
                                .string(),
                        )
                        .to_owned(),
                )
                .await?;
        }

        if !manager
            .has_column("canvas_revisions", "source_copilot_session_id")
            .await?
        {
            manager
                .alter_table(
                    Table::alter()
                        .table(Alias::new("canvas_revisions"))
                        .add_column(
                            ColumnDef::new(Alias::new("source_copilot_session_id")).string(),
                        )
                        .to_owned(),
                )
                .await?;
        }

        if !manager
            .has_index(
                "message_attachment_sets",
                "idx_message_attachment_sets_thread_session",
            )
            .await?
        {
            manager
                .create_index(
                    Index::create()
                        .name("idx_message_attachment_sets_thread_session")
                        .table(Alias::new("message_attachment_sets"))
                        .col(Alias::new("thread_id"))
                        .col(Alias::new("copilot_session_id"))
                        .col(Alias::new("user_message_index"))
                        .to_owned(),
                )
                .await?;
        }

        manager
            .get_connection()
            .execute_unprepared(
                r#"
                UPDATE message_attachment_sets
                SET copilot_session_id = (
                  SELECT threads.copilot_session_id
                  FROM threads
                  WHERE threads.id = message_attachment_sets.thread_id
                )
                WHERE copilot_session_id IS NULL;

                UPDATE canvases
                SET created_by_copilot_session_id = (
                  SELECT threads.copilot_session_id
                  FROM threads
                  WHERE threads.id = canvases.thread_id
                )
                WHERE created_by_user_message_index IS NOT NULL
                  AND created_by_copilot_session_id IS NULL;

                UPDATE canvases
                SET last_updated_by_copilot_session_id = (
                  SELECT threads.copilot_session_id
                  FROM threads
                  WHERE threads.id = canvases.thread_id
                )
                WHERE last_updated_by_user_message_index IS NOT NULL
                  AND last_updated_by_copilot_session_id IS NULL;

                UPDATE canvas_revisions
                SET source_copilot_session_id = (
                  SELECT threads.copilot_session_id
                  FROM canvases
                  JOIN threads ON threads.id = canvases.thread_id
                  WHERE canvases.id = canvas_revisions.canvas_id
                )
                WHERE source_user_message_index IS NOT NULL
                  AND source_copilot_session_id IS NULL;
                "#,
            )
            .await?;

        Ok(())
    }

    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        Ok(())
    }
}

export type TableColumn = {
  table_name: string
  column_name: string
}

export type TableDefinition<Row = Record<string, unknown>> = {
  Row: Row
  Insert: Partial<Row>
  Update: Partial<Row>
  Relationships: []
}

export type MinimalDatabase = {
  public: {
    Tables: Record<string, TableDefinition>
    Views: Record<string, TableDefinition>
    Functions: Record<string, unknown>
    Enums: Record<string, unknown>
    CompositeTypes: Record<string, unknown>
  }
}

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      sync_notebooks: {
        Row: {
          created_at: string
          manifest: Json
          manifest_version: number
          notebook_id: string
          owner_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          manifest: Json
          manifest_version?: number
          notebook_id: string
          owner_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          manifest?: Json
          manifest_version?: number
          notebook_id?: string
          owner_id?: string
          updated_at?: string
        }
        Relationships: []
      }
      sync_snapshots: {
        Row: {
          created_at: string
          notebook_id: string
          payload: Json
          snapshot_id: string
        }
        Insert: {
          created_at?: string
          notebook_id: string
          payload: Json
          snapshot_id: string
        }
        Update: {
          created_at?: string
          notebook_id?: string
          payload?: Json
          snapshot_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sync_snapshots_notebook_id_fkey"
            columns: ["notebook_id"]
            isOneToOne: false
            referencedRelation: "sync_notebooks"
            referencedColumns: ["notebook_id"]
          },
        ]
      }
      sync_v2_categories: {
        Row: {
          category_id: string
          change_seq: number
          deleted_at: string | null
          field_updated_at: Json
          name: string
          notebook_id: string
          owner_id: string
          sort_key: string
          updated_at: string
          updated_by_device_id: string
          version: number
        }
        Insert: {
          category_id: string
          change_seq: number
          deleted_at?: string | null
          field_updated_at: Json
          name: string
          notebook_id: string
          owner_id: string
          sort_key: string
          updated_at: string
          updated_by_device_id: string
          version: number
        }
        Update: {
          category_id?: string
          change_seq?: number
          deleted_at?: string | null
          field_updated_at?: Json
          name?: string
          notebook_id?: string
          owner_id?: string
          sort_key?: string
          updated_at?: string
          updated_by_device_id?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "sync_v2_categories_notebook_owner_fk"
            columns: ["notebook_id", "owner_id"]
            isOneToOne: false
            referencedRelation: "sync_v2_notebooks"
            referencedColumns: ["notebook_id", "owner_id"]
          },
        ]
      }
      sync_v2_changes: {
        Row: {
          change_seq: number
          created_at: string
          expected_version: number
          mutation_id: string | null
          notebook_id: string
          owner_id: string
          payload: Json
          record_id: string
          record_type: string
          request_payload: Json | null
        }
        Insert: {
          change_seq?: number
          created_at?: string
          expected_version: number
          mutation_id?: string | null
          notebook_id: string
          owner_id: string
          payload: Json
          record_id: string
          record_type: string
          request_payload?: Json | null
        }
        Update: {
          change_seq?: number
          created_at?: string
          expected_version?: number
          mutation_id?: string | null
          notebook_id?: string
          owner_id?: string
          payload?: Json
          record_id?: string
          record_type?: string
          request_payload?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "sync_v2_changes_notebook_owner_fk"
            columns: ["notebook_id", "owner_id"]
            isOneToOne: false
            referencedRelation: "sync_v2_notebooks"
            referencedColumns: ["notebook_id", "owner_id"]
          },
        ]
      }
      sync_v2_notebooks: {
        Row: {
          created_at: string
          notebook_id: string
          owner_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          notebook_id: string
          owner_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          notebook_id?: string
          owner_id?: string
          updated_at?: string
        }
        Relationships: []
      }
      sync_v2_tasks: {
        Row: {
          category_id: string
          change_seq: number
          deadline_date: string | null
          deleted_at: string | null
          field_updated_at: Json
          notebook_id: string
          owner_id: string
          scheduled_dates: Json
          sort_key: string
          task_id: string
          title: string
          updated_at: string
          updated_by_device_id: string
          version: number
        }
        Insert: {
          category_id: string
          change_seq: number
          deadline_date?: string | null
          deleted_at?: string | null
          field_updated_at: Json
          notebook_id: string
          owner_id: string
          scheduled_dates: Json
          sort_key: string
          task_id: string
          title: string
          updated_at: string
          updated_by_device_id: string
          version: number
        }
        Update: {
          category_id?: string
          change_seq?: number
          deadline_date?: string | null
          deleted_at?: string | null
          field_updated_at?: Json
          notebook_id?: string
          owner_id?: string
          scheduled_dates?: Json
          sort_key?: string
          task_id?: string
          title?: string
          updated_at?: string
          updated_by_device_id?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "sync_v2_tasks_category_fk"
            columns: ["notebook_id", "owner_id", "category_id"]
            isOneToOne: false
            referencedRelation: "sync_v2_categories"
            referencedColumns: ["notebook_id", "owner_id", "category_id"]
          },
          {
            foreignKeyName: "sync_v2_tasks_notebook_owner_fk"
            columns: ["notebook_id", "owner_id"]
            isOneToOne: false
            referencedRelation: "sync_v2_notebooks"
            referencedColumns: ["notebook_id", "owner_id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      compare_and_swap_sync_manifest: {
        Args: {
          p_expected_manifest_version: number
          p_manifest: Json
          p_notebook_id: string
        }
        Returns: {
          applied: boolean
          manifest: Json
          manifest_version: number
        }[]
      }
      create_sync_snapshot: {
        Args: { p_notebook_id: string; p_payload: Json; p_snapshot_id: string }
        Returns: {
          payload: Json
          status: string
        }[]
      }
      delete_pruned_sync_snapshot: {
        Args: { p_notebook_id: string; p_snapshot_id: string }
        Returns: boolean
      }
      initialize_sync_notebook: {
        Args: {
          p_manifest: Json
          p_notebook_id: string
          p_snapshot: Json
          p_snapshot_id: string
        }
        Returns: {
          manifest: Json
          manifest_version: number
        }[]
      }
      initialize_sync_v2_notebook: {
        Args: { p_categories?: Json; p_notebook_id: string; p_tasks?: Json }
        Returns: {
          category_count: number
          created_at: string
          notebook_id: string
          owner_id: string
          task_count: number
          updated_at: string
        }[]
      }
      mutate_sync_v2_category: {
        Args: {
          p_category_id: string
          p_expected_version: number
          p_mutation_id: string
          p_notebook_id: string
          p_payload: Json
        }
        Returns: {
          outcome: string
          record: Json
        }[]
      }
      mutate_sync_v2_task: {
        Args: {
          p_expected_version: number
          p_mutation_id: string
          p_notebook_id: string
          p_payload: Json
          p_task_id: string
        }
        Returns: {
          outcome: string
          record: Json
        }[]
      }
      read_sync_v2_changes: {
        Args: { p_after_seq?: number; p_limit?: number; p_notebook_id: string }
        Returns: {
          change_seq: number
          notebook_id: string
          owner_id: string
          payload: Json
          record_id: string
          record_type: string
        }[]
      }
      sync_v2_cascade_category_tasks: {
        Args: {
          p_category: Database["public"]["Tables"]["sync_v2_categories"]["Row"]
          p_parent_mutation_id: string
        }
        Returns: undefined
      }
      sync_v2_category_payload: {
        Args: {
          p_row: Database["public"]["Tables"]["sync_v2_categories"]["Row"]
        }
        Returns: Json
      }
      sync_v2_iso_timestamp: { Args: { p_value: string }; Returns: string }
      sync_v2_task_payload: {
        Args: { p_row: Database["public"]["Tables"]["sync_v2_tasks"]["Row"] }
        Returns: Json
      }
      sync_v2_valid_clock_map: {
        Args: { p_fields: string[]; p_value: Json }
        Returns: boolean
      }
      sync_v2_valid_date_array: { Args: { p_value: Json }; Returns: boolean }
      sync_v2_validate_local_payload: {
        Args: {
          p_expected_version: number
          p_payload: Json
          p_record_id: string
          p_record_type: string
        }
        Returns: undefined
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const

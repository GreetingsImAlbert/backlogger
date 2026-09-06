export interface Task {
  id: string;
  title: string;
  scheduledDates: string[];
  deadlineDate: string | null;
}

export interface Category {
  id: string;
  name: string;
  tasks: Task[];
}

// Array order is display order. Persistence will introduce schema metadata.
export interface Notebook { categories: Category[] }

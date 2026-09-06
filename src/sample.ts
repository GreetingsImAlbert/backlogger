// Opt-in demo fixtures. The UI explicitly maps these letters to the current week.
// They are never automatically imported as the user's actual dated backlog.
export interface SampleTask {
  title: string;
  work?: string;
  due?: string;
}

export interface SampleCategory {
  name: string;
  tasks: SampleTask[];
}

export const sampleCategories: SampleCategory[] = [
  { name: 'Eng 13', tasks: [
    { title: 'Read Lennard Davis', work: 'H,F,A,S' },
    { title: 'Read relevant articles and take notes', work: 'S' },
    { title: 'Start Tiger Technology', work: 'M' },
  ] },
  { name: 'Engg 150', tasks: [
    { title: 'Think of AI Box Assumptions', work: 'F', due: 'F' },
  ] },
  { name: 'Philo 1', tasks: [] },
  { name: 'ME 197', tasks: [
    { title: 'Read', work: 'M' },
    { title: 'Print Activity', work: 'M' },
  ] },
  { name: 'ME 195', tasks: [
    { title: 'Lean Canvas', work: 'M,T,W,H,F', due: 'F' },
  ] },
  { name: 'ME 190', tasks: [
    { title: 'Meeting 4', due: 'M' },
    { title: 'Presentation 3', work: 'M', due: 'W' },
    { title: 'Assignment 2', work: 'A', due: 'W' },
  ] },
  { name: 'ME 100', tasks: [
    { title: 'Presentation', work: 'M' },
  ] },
  { name: 'PE 2 CH', tasks: [] },
  { name: 'PE 2 MF', tasks: [
    { title: 'Asynch Activity', work: 'H', due: 'F' },
  ] },
];

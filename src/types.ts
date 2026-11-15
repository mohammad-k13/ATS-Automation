export interface Application {
  source: string;
  id: string;
  name: string;
  jobId?: string;
  jobTitle?: string;
  appliedAt?: string;
  profileUrl?: string;
  resumeUrl?: string;
  /** Resume text if the API returns it inline (skips download/parse). */
  resumeText?: string;
  /** Any extra fields from the API, passed to the scorer as context. */
  extra?: Record<string, unknown>;
  raw?: unknown;
}

export interface ResumeFile {
  data: Uint8Array;
  filename: string;
  contentType?: string;
}

export interface Source {
  name: string;
  listApplications(): Promise<Application[]>;
  downloadResume(app: Application): Promise<ResumeFile | null>;
  /** Optional: source can return resume text directly (structured CV) instead of a file. */
  getResumeText?(app: Application): Promise<string>;
}

export interface Criteria {
  name: string;
  match: { jobIds?: string[]; titleIncludes?: string[] };
  threshold: number;
  mustHave: string[];
  niceToHave: string[];
  hardFilters: { minYears?: number; requireAny?: string[]; rejectIfAny?: string[] };
  instructions?: string;
}

export interface ScoreResult {
  score: number;
  pass: boolean;
  matched: string[];
  missing: string[];
  redFlags: string[];
  summary: string;
  yearsExperience?: number | null;
  hardFilterFailures: string[];
  method: "llm" | "keyword";
}

export type Decision = "accepted" | "rejected" | "error";

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
      /** Contact phone. Private: stored for reports, never sent to the AI. */
      phone?: string;
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
      /** Score from here up to `threshold` = partial approval (تایید نسبی). */
      partialThreshold: number;
      mustHave: string[];
      niceToHave: string[];
      hardFilters: { minYears?: number; requireAny?: string[]; rejectIfAny?: string[] };
      instructions?: string;
}

export interface ScoreResult {
      score: number;
      pass: boolean;
      /** Not accepted, but good enough for partial approval. */
      partial: boolean;
      matched: string[];
      missing: string[];
      redFlags: string[];
      summary: string;
      yearsExperience?: number | null;
      hardFilterFailures: string[];
      method: 'llm' | 'keyword';
}

export type Decision = 'accepted' | 'partial' | 'rejected' | 'error' | 'pending';

/** accepted / partial / rejected from a score result. */
export const decisionOf = (r: { pass: boolean; partial?: boolean }): Decision =>
      r.pass ? 'accepted' : r.partial ? 'partial' : 'rejected';
/** Default partial threshold: 20 points under the accept threshold. */
export const defaultPartial = (threshold: number) => Math.max(0, threshold - 20);

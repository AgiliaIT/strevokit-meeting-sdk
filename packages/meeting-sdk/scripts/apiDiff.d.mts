export interface ApiDiff {
  breaking: string[];
  additive: string[];
}

export declare const INPUT_TYPES: ReadonlySet<string>;

export declare function diffApiReports(previousReport: string, currentReport: string): ApiDiff;

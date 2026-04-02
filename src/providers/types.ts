export interface DataProvider {
  name: string;
  close(): Promise<void>;
}

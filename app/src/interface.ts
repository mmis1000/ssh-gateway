export interface DataRow {
  id: number,
  method: string,
  path: string,
  code: number,
  req: Record<string, string | string[] | undefined>,
  res: Record<string, string | string[] | undefined>,
}

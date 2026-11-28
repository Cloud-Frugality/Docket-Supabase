// The shape of the supabase-js client the functions pass around. Structural
// rather than the real SupabaseClient type so this file stays import-free and
// the tests can load everything that uses it. createClient()'s client fits it.
export interface ServiceClient {
  // deno-lint-ignore no-explicit-any
  from(table: string): any;
  // deno-lint-ignore no-explicit-any
  rpc(fn: string, args?: Record<string, unknown>, options?: Record<string, unknown>): any;
  // deno-lint-ignore no-explicit-any
  storage: any;
  // deno-lint-ignore no-explicit-any
  auth: any;
}

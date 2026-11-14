// MCP surface — placeholder at the skeleton stage; the endpoint lands in the MCP stage.
import { errorBody, sendJson, type Ctx } from './http.ts';

export async function handleMcp(ctx: Ctx): Promise<void> {
  sendJson(ctx.res, 404, errorBody('Not Found'));
}

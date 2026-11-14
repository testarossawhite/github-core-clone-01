// GraphQL v4 surface — placeholder at the skeleton stage; the executor lands in the GraphQL stage.
import { errorBody, sendJson, type Ctx } from './http.ts';

export async function handleGraphql(ctx: Ctx): Promise<void> {
  sendJson(ctx.res, 404, errorBody('Not Found'));
}

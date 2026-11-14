// REST v3 surface — placeholder at the skeleton stage; the resource routes land in the REST stage.
import { errorBody, sendJson, type Ctx } from './http.ts';

export async function handleRest(ctx: Ctx, _restPath: string): Promise<void> {
  void ctx.forge;
  sendJson(ctx.res, 404, errorBody('Not Found'));
}

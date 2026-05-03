import type { ApiRequest, ApiResponse, ApiRouteContext } from "./route-context.js";

export interface RouteModule {
  handle(request: ApiRequest, context: ApiRouteContext): Promise<ApiResponse | undefined>;
}

import type {
  DefaultResourceHandler,
} from "../types/desktop";

export interface ResourceHandlerCandidate {
  appId: string;
  handler: {
    id: string;
  };
}

export function resourceHandlerKey(
  extension: string,
  action: "open" | "edit",
) {
  return `extension:${extension.toLowerCase()}:${action}`;
}

export function selectResourceHandler<T extends ResourceHandlerCandidate>(
  candidates: T[],
  defaults: Record<string, DefaultResourceHandler>,
  extension: string,
  action: "open" | "edit",
): T | undefined {
  const preferred = defaults[resourceHandlerKey(extension, action)];
  if (preferred) {
    const match = candidates.find(
      (candidate) =>
        candidate.appId === preferred.appId &&
        candidate.handler.id === preferred.handlerId,
    );
    if (match) {
      return match;
    }
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

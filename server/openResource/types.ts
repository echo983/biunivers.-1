export interface ResourceHandler {
  id: string;
  actions: Array<"open" | "edit">;
  extensions: string[];
  mediaTypes?: string[];
  access: "read" | "read-write";
  multiple?: boolean;
}

export type OpenResourceProtocol =
  "biunivers.open-resource/1" | "biunivers.open-resource/1.1";

export interface OpenResourceDeclaration {
  protocol: OpenResourceProtocol;
  handlers: ResourceHandler[];
}

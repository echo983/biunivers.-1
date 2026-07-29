export interface ResourceHandler {
  id: string;
  actions: Array<"open" | "edit">;
  extensions: string[];
  mediaTypes?: string[];
  access: "read" | "read-write";
}

export interface OpenResourceDeclaration {
  protocol: "biunivers.open-resource/1";
  handlers: ResourceHandler[];
}

export type ConfigurationValue = string | number | boolean;

interface ConfigurationBase {
  key: string;
  label: string;
  description?: string;
  required: boolean;
}

export type ConfigurationDefinition =
  | (ConfigurationBase & {
      type: "string";
      default?: string;
    })
  | (ConfigurationBase & {
      type: "boolean";
      default?: boolean;
    })
  | (ConfigurationBase & {
      type: "integer";
      default?: number;
      minimum?: number;
      maximum?: number;
    })
  | (ConfigurationBase & {
      type: "number";
      default?: number;
      minimum?: number;
      maximum?: number;
    })
  | (ConfigurationBase & {
      type: "select";
      default?: string;
      options: string[];
    });

export interface AppManifest {
  formatVersion: 1;
  protocol: "biunivers.static-app/1";
  appId: string;
  version: string;
  name: string;
  description?: string;
  license: string;
  icon: string;
  window: {
    defaultWidth: number;
    defaultHeight: number;
    minWidth?: number;
    minHeight?: number;
    desktop?: boolean;
    pinned?: boolean;
  };
  configuration: ConfigurationDefinition[];
}

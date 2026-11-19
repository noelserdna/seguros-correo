/** La configuración del módulo de WhatsApp, leída una vez y compartida por avisos y envíos. */
import { loadConfig, type Config } from "../../config.ts";

export type Settings = {
  mailbox: string | undefined;
  folder: string;
  verifyToken: string | undefined;
  appSecret: string | undefined;
  token: string | undefined;
  phoneNumberId: string | undefined;
  graphUrl: string;
};

export function settingsFrom(config: Partial<Config> | undefined): Settings {
  return {
    mailbox: config?.WHATSAPP_MAILBOX,
    folder: config?.WHATSAPP_FOLDER ?? "WhatsApp",
    verifyToken: config?.WHATSAPP_VERIFY_TOKEN,
    appSecret: config?.WHATSAPP_APP_SECRET,
    token: config?.WHATSAPP_TOKEN,
    phoneNumberId: config?.WHATSAPP_PHONE_NUMBER_ID,
    graphUrl: (config?.WHATSAPP_GRAPH_URL ?? "https://graph.facebook.com/v21.0").replace(/\/$/, ""),
  };
}

let active: Settings | null = null;

/** Las rutas del módulo la fijan al montarse; los envíos la leen de aquí. */
export function setSettings(settings: Settings): void {
  active = settings;
}

export function currentSettings(): Settings {
  active ??= settingsFrom(loadConfig());
  return active;
}

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";

/**
 * Cifra las credenciales de los buzones con AES-256-GCM. La clave maestra vive
 * fuera de la base de datos (variable MASTER_KEY, 64 caracteres hexadecimales).
 */
export class SecretBox {
  readonly #key: Buffer;

  constructor(masterKeyHex: string) {
    if (!/^[0-9a-f]{64}$/i.test(masterKeyHex)) {
      throw new Error("MASTER_KEY debe tener 64 caracteres hexadecimales (32 bytes).");
    }
    this.#key = Buffer.from(masterKeyHex, "hex");
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return [VERSION, iv, cipher.getAuthTag(), data]
      .map((part) => (typeof part === "string" ? part : part.toString("base64")))
      .join(":");
  }

  decrypt(sealed: string): string {
    const [version, iv, tag, data] = sealed.split(":");
    if (version !== VERSION || !iv || !tag || data === undefined) {
      throw new Error("Formato de secreto cifrado no reconocido.");
    }
    const decipher = createDecipheriv("aes-256-gcm", this.#key, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString(
      "utf8",
    );
  }
}

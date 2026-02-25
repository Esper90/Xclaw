import crypto from "crypto";
import { config } from "../../config";

/**
 * Returns the master AES-256 key, derived by SHA-256 hashing the env var.
 * (Hashing ensures it is exactly 32 bytes, as required by AES-256).
 */
function getMasterKey(): Buffer {
    if (!config.PINECONE_MASTER_KEY) {
        throw new Error("PINECONE_MASTER_KEY is not defined in the environment.");
    }
    return crypto.createHash("sha256").update(config.PINECONE_MASTER_KEY).digest();
}

/**
 * Generates a completely new cryptographically secure 256-bit key for a user.
 */
export function generateUserKey(): Buffer {
    return crypto.randomBytes(32);
}

/**
 * Encrypts a user's raw key using the global PINECONE_MASTER_KEY.
 * The resulting string goes into Supabase.
 * Format: `IV:AuthTag:Ciphertext` (all in hex)
 */
export function encryptUserKey(rawKey: Buffer): string {
    const iv = crypto.randomBytes(12); // Standard IV size for GCM
    const masterKey = getMasterKey();

    const cipher = crypto.createCipheriv("aes-256-gcm", masterKey, iv);

    let encrypted = cipher.update(rawKey);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    const authTag = cipher.getAuthTag();

    return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

/**
 * Decrypts a user's encrypted key string from Supabase using the PINECONE_MASTER_KEY.
 * Returns the raw AES key buffer to use for their Pinecone records.
 */
export function decryptUserKey(encryptedStr: string): Buffer {
    const parts = encryptedStr.split(":");
    if (parts.length !== 3) {
        throw new Error("Invalid encrypted user key format. Expected IV:AuthTag:Ciphertext.");
    }

    const iv = Buffer.from(parts[0], "hex");
    const authTag = Buffer.from(parts[1], "hex");
    const encryptedData = Buffer.from(parts[2], "hex");
    const masterKey = getMasterKey();

    const decipher = crypto.createDecipheriv("aes-256-gcm", masterKey, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encryptedData);
    decrypted = Buffer.concat([decrypted, decipher.final()]);

    return decrypted;
}

/**
 * Encrypts a JSON-serializable metadata payload using the user's specific key.
 * This cipher string is what actually gets stored in Pinecone's metadata.
 */
export function encryptPayload(payload: Record<string, any>, userKey: Buffer): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", userKey, iv);

    const textData = JSON.stringify(payload);
    let encrypted = cipher.update(textData, "utf8");
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    const authTag = cipher.getAuthTag();

    return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

/**
 * Decrypts the cipher string from Pinecone metadata back into a JSON object 
 * using the user's specific key.
 */
export function decryptPayload<T = Record<string, unknown>>(encryptedStr: string, userKey: Buffer): T {
    const parts = encryptedStr.split(":");
    if (parts.length !== 3) {
        throw new Error("Invalid encrypted payload format in Pinecone. Expected IV:AuthTag:Ciphertext.");
    }

    const iv = Buffer.from(parts[0], "hex");
    const authTag = Buffer.from(parts[1], "hex");
    const encryptedData = Buffer.from(parts[2], "hex");

    const decipher = crypto.createDecipheriv("aes-256-gcm", userKey, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encryptedData);
    decrypted = Buffer.concat([decrypted, decipher.final()]);

    return JSON.parse(decrypted.toString("utf8")) as T;
}

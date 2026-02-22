import type { Request, Response, NextFunction } from "express";
import { config } from "../config";


/**
 * Bearer token auth middleware for REST API endpoints.
 * Checks Authorization: Bearer <REST_API_KEY>
 */
export function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
    const authHeader = req.headers["authorization"];

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        res.status(401).json({ error: "Unauthorized", message: "Missing Authorization header" });
        return;
    }

    const token = authHeader.slice(7);
    if (token !== config.REST_API_KEY) {
        res.status(401).json({ error: "Unauthorized", message: "Invalid API key" });
        return;
    }

    next();
}

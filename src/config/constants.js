import { config } from "dotenv";

config();
export const PORT = process.env.PORT || 5000;
export const DB_NAME = "";
export const MONGODB_URI = process.env.MONGODB_URI || "";

// controller/errorController.js
import mongoose from "mongoose";
import { ErrorLogModel } from "../model/errorLog.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { ApiError } from "../utils/ApiErrors.js";

const sanitizeBoolean = (value) => {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return undefined;
};

const escapeRegex = (value = "") =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const toSafeInt = (value, fallback) => {
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
};

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

const createErrorLog = asyncHandler(async (req, res) => {
  const payload = req?.body || {};

  if (!payload?.message) {
    throw new ApiError(400, "message is required");
  }

  const doc = await ErrorLogModel.create({
    source: payload?.source || "unknown",
    module: payload?.module || "",
    stage: payload?.stage || "",
    level: payload?.level || "error",
    message: payload?.message || "Unknown error",
    errorName: payload?.errorName || "",
    statusCode: payload?.statusCode ?? null,
    stack: payload?.stack || "",
    request: payload?.request || {},
    response: payload?.response || {},
    context: payload?.context || {},
    externalService: payload?.externalService || {},
    meta: payload?.meta ?? null,
    resolved: false,
  });

  if (!doc) {
    throw new ApiError(500, "Failed to create error log");
  }

  return res
    .status(201)
    .json(new ApiResponse(201, doc, "Error log created successfully"));
});

const getErrorLogs = asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 20,
    source,
    module,
    stage,
    level,
    statusCode,
    email,
    flag,
    orderId,
    resolved,
    search,
    startDate,
    endDate,
    sortBy = "createdAt",
    sortOrder = "desc",
  } = req?.query || {};

  const safePage = Math.max(toSafeInt(page, 1), 1);
  const safeLimit = Math.min(Math.max(toSafeInt(limit, 20), 1), 200);

  const filter = {};

  if (source) filter.source = source;
  if (module) filter.module = module;
  if (stage) filter.stage = stage;
  if (level) filter.level = level;
  if (statusCode && !Number.isNaN(Number(statusCode))) {
    filter.statusCode = Number(statusCode);
  }
  if (email) {
    filter["context.email"] = new RegExp(`^${escapeRegex(email)}$`, "i");
  }
  if (flag) filter["context.flag"] = flag;
  if (orderId) filter["context.orderId"] = orderId;

  const resolvedValue = sanitizeBoolean(resolved);
  if (typeof resolvedValue === "boolean") {
    filter.resolved = resolvedValue;
  }

  if (startDate || endDate) {
    filter.createdAt = {};
    if (startDate) {
      const start = new Date(startDate);
      if (!Number.isNaN(start.getTime())) {
        filter.createdAt.$gte = start;
      }
    }
    if (endDate) {
      const end = new Date(endDate);
      if (!Number.isNaN(end.getTime())) {
        end.setHours(23, 59, 59, 999);
        filter.createdAt.$lte = end;
      }
    }
    if (!filter.createdAt.$gte && !filter.createdAt.$lte) {
      delete filter.createdAt;
    }
  }

  if (search) {
    const regex = new RegExp(escapeRegex(search), "i");
    filter.$or = [
      { message: regex },
      { errorName: regex },
      { module: regex },
      { stage: regex },
      { source: regex },
      { "context.email": regex },
      { "context.orderId": regex },
      { "externalService.name": regex },
    ];
  }

  const allowedSortFields = [
    "createdAt",
    "updatedAt",
    "statusCode",
    "level",
    "source",
    "module",
    "stage",
  ];

  const finalSortBy = allowedSortFields.includes(sortBy) ? sortBy : "createdAt";
  const finalSortOrder = sortOrder === "asc" ? 1 : -1;

  const [rows, total] = await Promise.all([
    ErrorLogModel.find(filter)
      .sort({ [finalSortBy]: finalSortOrder, _id: -1 })
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit)
      .lean(),
    ErrorLogModel.countDocuments(filter),
  ]);

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        data: rows,
        filters: {
          source: source || "",
          module: module || "",
          stage: stage || "",
          level: level || "",
          statusCode: statusCode || "",
          email: email || "",
          flag: flag || "",
          orderId: orderId || "",
          resolved: resolved ?? "",
          search: search || "",
          startDate: startDate || "",
          endDate: endDate || "",
          sortBy: finalSortBy,
          sortOrder: sortOrder === "asc" ? "asc" : "desc",
        },
        pagination: {
          page: safePage,
          limit: safeLimit,
          total,
          totalPages: Math.ceil(total / safeLimit) || 1,
        },
      },
      "Error logs fetched successfully",
    ),
  );
});

const getErrorLogById = asyncHandler(async (req, res) => {
  const id = req?.params?.id;

  if (!id || !isValidObjectId(id)) {
    throw new ApiError(400, "Invalid error log ID");
  }

  const doc = await ErrorLogModel.findById(id).lean();

  if (!doc) {
    throw new ApiError(404, "Error log not found");
  }

  return res
    .status(200)
    .json(new ApiResponse(200, doc, "Error log fetched successfully"));
});

const updateErrorResolution = asyncHandler(async (req, res) => {
  const id = req?.params?.id;
  const resolved = req?.body?.resolved;

  if (!id || !isValidObjectId(id)) {
    throw new ApiError(400, "Invalid error log ID");
  }

  if (typeof resolved !== "boolean") {
    throw new ApiError(400, "resolved must be boolean");
  }

  const updated = await ErrorLogModel.findByIdAndUpdate(
    id,
    {
      $set: {
        resolved,
        resolvedAt: resolved ? new Date() : null,
      },
    },
    { new: true, runValidators: true },
  ).lean();

  if (!updated) {
    throw new ApiError(404, "Error log not found");
  }

  return res
    .status(200)
    .json(new ApiResponse(200, updated, "Error log updated successfully"));
});

const deleteErrorLog = asyncHandler(async (req, res) => {
  const id = req?.params?.id;

  if (!id || !isValidObjectId(id)) {
    throw new ApiError(400, "Invalid error log ID");
  }

  const deleted = await ErrorLogModel.findByIdAndDelete(id).lean();

  if (!deleted) {
    throw new ApiError(404, "Error log not found");
  }

  return res
    .status(200)
    .json(new ApiResponse(200, deleted, "Error log deleted successfully"));
});

const bulkDeleteErrorLogs = asyncHandler(async (req, res) => {
  const ids = req?.body?.ids;

  if (!Array.isArray(ids) || ids.length === 0) {
    throw new ApiError(400, "ids must be a non-empty array");
  }

  const invalidIds = ids.filter((id) => !isValidObjectId(id));
  if (invalidIds.length > 0) {
    throw new ApiError(400, "One or more error log IDs are invalid");
  }

  const result = await ErrorLogModel.deleteMany({
    _id: { $in: ids },
  });

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        deletedCount: result?.deletedCount || 0,
      },
      "Error logs deleted successfully",
    ),
  );
});

export {
  createErrorLog,
  getErrorLogs,
  getErrorLogById,
  updateErrorResolution,
  deleteErrorLog,
  bulkDeleteErrorLogs,
};

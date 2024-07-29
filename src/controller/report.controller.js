import { Report } from "../model/reportModel.model.js";
import { ApiError } from "../utils/ApiErrors.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const createReport = asyncHandler(async (req, res) => {
  const { age, medication, state, city } = req.body;
  if ([medication, state, city].some((field) => field.trim() === "")) {
    throw new ApiError(400, "All field required");
  }
  const report = await Report.create({ age, medication, state, city });
  if (!report) throw new ApiError(400, "Failed to create the report");

  return res.status(200).json(new ApiResponse(200, report, "report added"));
});
const reportDetails = asyncHandler(async (req, res) => {
  const report = await Report.find();
  if (!report) throw new ApiError(400, "Report not found");
  return res.status(200).json(new ApiResponse(200, report, "report details"));
});

const filteredByAge = asyncHandler(async (req, res) => {
  const totalDocsCount = await Report.countDocuments();
  const { age } = req.query;

  const report = await Report.find({ age: age });

  const object = report.map((data) => ({
    medication: data.medication,
    age: data.age,
    state: data.state,
    city: data.city,
  }));

  const response = {
    ageGroupDetails: object,
    totalCount: report.length,
    percentage: `${Math.floor((report.length / totalDocsCount) * 100)} %`,
  };
  return res
    .status(200)
    .json(new ApiResponse(200, response, "Records fetched"));
});

const filteredByMedication = asyncHandler(async (req, res) => {
  const totalDocsCount = await Report.countDocuments();

  const { medication } = req.query;

  const report = await Report.find({ medication });

  const object = report.map((data) => ({
    medication: data.medication,
    age: data.age,
    state: data.state,
    city: data.city,
  }));

  const response = {
    medicationGroupDetails: object,
    totalCount: report.length,
    percentage: `${Math.floor((report.length / totalDocsCount) * 100)} %`,
  };
  return res
    .status(200)
    .json(new ApiResponse(200, response, "Records fetched"));
});
const filteredByState = asyncHandler(async (req, res) => {
  const totalDocsCount = await Report.countDocuments();

  const { state, city } = req.query;

  const report = await Report.find({ $or: [{ state }, { city }] });

  const object = report.map((data) => ({
    medication: data.medication,
    age: data.age,
    state: data.state,
    city: data.city,
  }));

  const response = {
    medicationGroupDetails: object,
    totalCount: report.length,
    percentage: `${Math.floor((report.length / totalDocsCount) * 100)} %`,
  };
  return res
    .status(200)
    .json(new ApiResponse(200, response, "Records fetched"));
});

export {
  createReport,
  reportDetails,
  filteredByAge,
  filteredByMedication,
  filteredByState,
};

import { Report } from "../model/reportModel.model.js";
import { ApiError } from "../utils/ApiErrors.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const createReport = asyncHandler(async (req, res) => {
  const { age, medication, state, city, ipAddress } = req.body;
  if (
    [medication, state, city, ipAddress].some((field) => field.trim() === "")
  ) {
    throw new ApiError(400, "All field required");
  }
  const location = `${state} ${city}`;
  const currentTime = new Date();

  let submission = await Report.findOne({ ipAddress });
  if (submission) {
    const timeDifference =
      (currentTime - submission.lastSubmission) / (1000 * 60 * 60); // in hours
    if (timeDifference < 36) {
      return res
        .status(429)
        .json(
          new ApiResponse(
            429,
            [],
            "Submission not allowed. Please wait 36 hours before trying again."
          )
        );
    }
    submission.lastSubmission = currentTime;
    await submission.save();
  } else {
    const report = await Report.create({
      age,
      medication,
      state,
      city,
      location,
      ipAddress,
      lastSubmission: currentTime,
    });

    if (!report) throw new ApiError(400, "Failed to create the report");

    return res.status(200).json(new ApiResponse(200, report, "report added"));
  }
});

const reportDetails = asyncHandler(async (_, res) => {
  const report = await Report.find();
  if (!report) throw new ApiError(400, "Report not found");
  const totalRecords = report.length;

  const ageCounts = report.reduce((acc, item) => {
    acc[item.age] = (acc[item.age] || 0) + 1;
    return acc;
  }, {});
  const medicationCounts = report.reduce((acc, item) => {
    acc[item.medication] = (acc[item.medication] || 0) + 1;
    return acc;
  }, {});

  const stateCounts = report.reduce((acc, item) => {
    acc[item.state] = (acc[item.state] || 0) + 1;
    return acc;
  }, {});

  const cityCounts = report.reduce((acc, item) => {
    acc[item.city] = (acc[item.city] || 0) + 1;
    return acc;
  }, {});

  const locationCounts = report.reduce((acc, item) => {
    acc[item.location] = (acc[item.location] || 0) + 1;
    return acc;
  }, {});

  const ageArray = Object.keys(ageCounts)
    .map((key) => ({
      age: key,
      count: ageCounts[key],
      percentage: parseFloat(
        ((ageCounts[key] / totalRecords) * 100).toFixed(2)
      ),
    }))
    .sort((a, b) => b.count - a.count); // Sorting in descending order

  const medicationArray = Object.keys(medicationCounts)
    .map((key) => ({
      medication: key,
      count: medicationCounts[key],
      percentage: parseFloat(
        ((medicationCounts[key] / totalRecords) * 100).toFixed(2)
      ),
    }))
    .sort((a, b) => b.count - a.count);

  const stateArray = Object.keys(stateCounts)
    .map((key) => ({
      ucName: key.toUpperCase(),
      value: stateCounts[key],
      percentage: parseFloat(
        ((stateCounts[key] / totalRecords) * 100).toFixed(2)
      ),
    }))
    .sort((a, b) => b.count - a.count);

  const cityArray = Object.keys(cityCounts)
    .map((key) => ({
      city: key,
      count: cityCounts[key],
      percentage: parseFloat(
        ((cityCounts[key] / totalRecords) * 100).toFixed(2)
      ),
    }))
    .sort((a, b) => b.count - a.count);

  const locationArray = Object.keys(locationCounts)
    .map((key) => ({
      location: key,
      count: locationCounts[key],
      percentage: parseFloat(
        ((locationCounts[key] / totalRecords) * 100).toFixed(2)
      ),
    }))
    .sort((a, b) => b.count - a.count);

  res.json({
    totalRecords,
    ageArray,
    medicationArray,
    stateArray,
    cityArray,
    locationArray,
  });
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

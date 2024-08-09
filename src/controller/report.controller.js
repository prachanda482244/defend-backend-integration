import { Report } from "../model/reportModel.model.js";
import { ApiError } from "../utils/ApiErrors.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const createReport = asyncHandler(async (req, res) => {
  const { age, medication, state, city, ipAddress } = req.body;
  if ([medication, state, city].some((field) => field.trim() === "")) {
    throw new ApiError(400, "All fields are required.");
  }

  const location = `${state} ${city}`;
  const currentTime = new Date();

  // let submission = await Report.findOne({ ipAddress });
  // if (submission) {
  // const timeDifference =
  // (currentTime - submission.lastSubmission) / (1000 * 60 * 60);
  // if (timeDifference < 36) {
  // return res
  //   .status(429)
  //   .json(
  //     new ApiResponse(
  //       429,
  //       [],
  //       "Submission not allowed. Please wait 36 hours before trying again."
  //     )
  //   );
  // }

  // Update the lastSubmission time and save the report
  // submission.age = age;
  // submission.medication = medication;
  // submission.state = state;
  // submission.city = city;
  // submission.location = location;
  // submission.lastSubmission = currentTime;
  // await submission.save();

  // return res
  // .status(200)
  // .json(new ApiResponse(200, submission, "Report updated."));
  // } else {
  const report = await Report.create({
    age,
    medication,
    state,
    city,
    location,
    ipAddress: "192.3.4",
    lastSubmission: currentTime,
  });

  if (!report) throw new ApiError(400, "Failed to create the report");

  return res.status(200).json(new ApiResponse(200, report, "Report added."));
  // }
});

const reportDetails = asyncHandler(async (_, res) => {
  const report = await Report.find();
  if (!report) throw new ApiError(400, "Report not found");
  const totalRecords = report.length;

  // Initialize aggregation containers
  const medicationDetails = {};
  const stateDetails = {};

  // Aggregate data
  report.forEach((item) => {
    // Medication details
    if (!medicationDetails[item.medication]) {
      medicationDetails[item.medication] = { totalCount: 0, ageGroups: {} };
    }
    medicationDetails[item.medication].totalCount += 1;

    if (!medicationDetails[item.medication].ageGroups[item.age]) {
      medicationDetails[item.medication].ageGroups[item.age] = {
        count: 0,
        states: {},
      };
    }
    medicationDetails[item.medication].ageGroups[item.age].count += 1;
    medicationDetails[item.medication].ageGroups[item.age].states[item.state] =
      (medicationDetails[item.medication].ageGroups[item.age].states[
        item.state
      ] || 0) + 1;

    // State details
    if (!stateDetails[item.state]) {
      stateDetails[item.state] = {};
    }
    if (!stateDetails[item.state][item.age]) {
      stateDetails[item.state][item.age] = {
        count: 0,
        medications: {},
      };
    }
    stateDetails[item.state][item.age].count += 1;
    stateDetails[item.state][item.age].medications[item.medication] =
      (stateDetails[item.state][item.age].medications[item.medication] || 0) +
      1;
  });

  // Transform medication details into desired format
  const barAndChartData = Object.keys(medicationDetails).map((medication) => {
    const totalCount = medicationDetails[medication].totalCount;
    return {
      medication,
      totalCount,
      percentage: parseFloat(((totalCount / totalRecords) * 100).toFixed(2)),
      ageGroups: Object.keys(medicationDetails[medication].ageGroups).map(
        (age) => {
          const ageGroup = medicationDetails[medication].ageGroups[age];
          return {
            age,
            count: ageGroup.count,
            states: Object.keys(ageGroup.states).map((state) => ({
              state,
              count: ageGroup.states[state],
            })),
          };
        }
      ),
    };
  });

  // Transform state details into desired format
  const locationData = Object.keys(stateDetails).map((state) => {
    const ageGroups = Object.keys(stateDetails[state]).map((age) => {
      const ageGroup = stateDetails[state][age];
      return {
        age,
        count: ageGroup.count,
        medications: Object.keys(ageGroup.medications).map((medication) => ({
          medication,
          count: ageGroup.medications[medication],
          percentage: parseFloat(
            ((ageGroup.medications[medication] / totalRecords) * 100).toFixed(2)
          ),
        })),
      };
    });

    return {
      ucName: state.toUpperCase(),
      value: Object.keys(stateDetails[state]).reduce(
        (acc, age) => acc + stateDetails[state][age].count,
        0
      ),
      ageGroups,
    };
  });

  // Send the response
  res
    .status(200)
    .json(
      new ApiResponse(
        200,
        { totalRecords, barAndChartData, locationData },
        "data"
      )
    );
});

export { createReport, reportDetails };

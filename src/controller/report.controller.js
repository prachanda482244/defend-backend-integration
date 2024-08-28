import { Chart } from "../model/ChartModel.js";
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
    const { medication, age, state, city, createdAt } = item;

    // Medication details
    if (!medicationDetails[medication]) {
      medicationDetails[medication] = { totalCount: 0, ageGroups: {} };
    }
    medicationDetails[medication].totalCount += 1;

    if (!medicationDetails[medication].ageGroups[age]) {
      medicationDetails[medication].ageGroups[age] = {
        count: 0,
        states: {},
        createdAt, // Store the createdAt date here
      };
    }
    medicationDetails[medication].ageGroups[age].count += 1;

    if (!medicationDetails[medication].ageGroups[age].states[state]) {
      medicationDetails[medication].ageGroups[age].states[state] = {
        count: 0,
        cities: [],
      };
    }
    medicationDetails[medication].ageGroups[age].states[state].count += 1;

    // Check if the city already exists in the cities array
    const existingCityIndex = medicationDetails[medication].ageGroups[
      age
    ].states[state].cities.findIndex((c) => c.name === city);

    if (existingCityIndex !== -1) {
      // If city exists, increment the count
      medicationDetails[medication].ageGroups[age].states[state].cities[
        existingCityIndex
      ].count += 1;
    } else {
      // If city doesn't exist, add it with count = 1
      medicationDetails[medication].ageGroups[age].states[state].cities.push({
        name: city,
        count: 1,
      });
    }

    // State details
    if (!stateDetails[state]) {
      stateDetails[state] = {};
    }
    if (!stateDetails[state][age]) {
      stateDetails[state][age] = {
        count: 0,
        medications: {},
        cities: [],
        createdAt,
      };
    }
    stateDetails[state][age].count += 1;

    if (!stateDetails[state][age].medications[medication]) {
      stateDetails[state][age].medications[medication] = 0;
    }
    stateDetails[state][age].medications[medication] += 1;

    // Check if the city already exists in the cities array
    const existingCityIndexState = stateDetails[state][age].cities.findIndex(
      (c) => c.city === city
    );

    if (existingCityIndexState !== -1) {
      // If city exists, increment the count
      stateDetails[state][age].cities[existingCityIndexState].count += 1;
    } else {
      // If city doesn't exist, add it with count = 1
      stateDetails[state][age].cities.push({
        city,
        count: 1,
      });
    }
  });

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
              count: ageGroup.states[state].count,
              cities: ageGroup.states[state].cities,
            })),
            createdAt: new Date(ageGroup.createdAt).toLocaleDateString("en-US"),
          };
        }
      ),
    };
  });

  const locationData = Object.keys(stateDetails).map((state) => {
    const ageGroups = Object.keys(stateDetails[state]).map((age) => {
      const ageGroup = stateDetails[state][age];
      const medicationDetails = Object.keys(ageGroup.medications).map(
        (medication) => {
          const citiesForMedication = ageGroup.cities.filter((cityDetail) =>
            ageGroup.medications.hasOwnProperty(medication)
          );

          return {
            medication,
            count: ageGroup.medications[medication],
            percentage: parseFloat(
              ((ageGroup.medications[medication] / totalRecords) * 100).toFixed(
                2
              )
            ),
            cities: citiesForMedication.map((cityDetail) => ({
              city: cityDetail.city,
              count: cityDetail.count,
            })),
          };
        }
      );

      // Calculate the total count for tooltip lines
      const tooltipLinesCount = medicationDetails.flatMap((med) =>
        med.cities.map(() => 1)
      ).length;

      return {
        age,
        count: tooltipLinesCount,
        medications: medicationDetails,
        createdAt: new Date(ageGroup.createdAt).toLocaleDateString("en-US"),
      };
    });

    // Calculate the total count for this state
    const totalStateCount = ageGroups.reduce(
      (sum, ageGroup) => sum + ageGroup.count,
      0
    );

    return {
      ucName: state.toUpperCase(),
      value: totalStateCount,
      ageGroups,
    };
  });

  const tableData = report.map((report) => ({
    city: report.city,
    state: report.state,
    ageGroup: report.age,
    drug: report.medication,
    date: new Date(report.createdAt),
  }));

  const sortedTableData = tableData.sort((a, b) => b.date - a.date);

  const formattedTableData = sortedTableData.map((data) => ({
    cityState: `${data.city} , ${data.state}`,
    ageGroup: data.ageGroup,
    drug: data.drug,
    date: data.date.toLocaleDateString("en-US"),
  }));

  const reportData = await Report.find({}, "city");
  const uniqueCities = [...new Set(reportData.map((report) => report.city))];
  const response = await Promise.all(
    uniqueCities.map(async (city) => {
      const cityResponse = await Report.find({ city });
      const cityGeoLocation = await Chart.findOne({ name: city });
      if (cityGeoLocation) {
        const obj = {
          name: cityGeoLocation.name,
          lat: cityGeoLocation.lat,
          lon: cityGeoLocation.lon,
          data: cityResponse.map((report) => ({
            ageGroups: [
              {
                age: report.age || "Unknown",
                medications: [
                  {
                    medication: report.medication || "Unknown",
                    count: 1,
                  },
                ],
                createdAt: new Date(report.createdAt).toLocaleDateString(
                  "en-US"
                ),
              },
            ],
          })),
        };

        return obj;
      }

      return null;
    })
  );

  const filteredResponse = response.filter((city) => city !== null);

  res.status(200).json(
    new ApiResponse(
      200,
      {
        totalRecords,
        barAndChartData,
        locationData,
        formattedTableData,
        filteredResponse,
      },
      "data"
    )
  );
});

export { createReport, reportDetails };

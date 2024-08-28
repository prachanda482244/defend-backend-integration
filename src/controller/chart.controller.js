import { Chart } from "../model/ChartModel.js";
import { ApiError } from "../utils/ApiErrors.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import fs from "fs";
import csv from "csv-parser";

const addChartData = asyncHandler(async (req, res) => {
  const results = [];
  const uniqueEntries = new Set(); // Track unique entries

  fs.createReadStream("./src/assets/uscities.csv")
    .pipe(csv())
    .on("data", (data) => {
      const name = data.city;
      const state = data.state_name;
      const lat = parseFloat(data.lat);
      const lon = parseFloat(data.lng);

      // Create a unique key for each combination of name, state, lat, lon
      const uniqueKey = `${name}-${state}-${lat}-${lon}`;

      // If the unique key is not already in the set, add it
      if (!uniqueEntries.has(uniqueKey)) {
        uniqueEntries.add(uniqueKey);
        results.push({ name, state, lat, lon });
      }
    })
    .on("end", async () => {
      try {
        const chart = await Chart.insertMany(results); // Insert all unique results at once
        res.status(200).json(new ApiResponse(200, chart, "Added chart data"));
      } catch (error) {
        throw new ApiError(400, "Error while creating chart data");
      }
    });
});

const showChartData = asyncHandler(async (_, res) => {
  const chart = await Chart.find().select("-createdAt -updatedAt -__v -_id");
  if (!chart) throw new ApiError(404, "Chart not found");

  res.status(200).json(new ApiResponse(200, chart, "Chart data"));
});
const deleteChart = asyncHandler(async (req, res) => {
  const chart = await Chart.deleteMany({});
  if (!chart) throw new ApiError(400, "Failed to delete the chart data");
  res
    .status(200)
    .json(new ApiResponse(200, [], "Chart data deleted successfully"));
});
export { addChartData, showChartData, deleteChart };

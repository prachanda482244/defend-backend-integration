import { Chart } from "../model/ChartModel.js";
import { ApiError } from "../utils/ApiErrors.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import fs from "fs";
import csv from "csv-parser";

const addChartData = asyncHandler(async (req, res) => {
  const results = [];

  fs.createReadStream("./src/assets/uscities.csv")
    .pipe(csv())
    .on("data", (data) => {
      results.push({
        name: data.city,
        lat: parseFloat(data.lat),
        lon: parseFloat(data.lng),
      });
    })
    .on("end", async () => {
      //   const jsonData = JSON.stringify(results, null, 2);
      console.log("success");
      const chart = await Chart.create(results);
      if (!chart) throw new ApiError(400, "Error while creating a chart data");
      res.status(200).json(new ApiResponse(200, chart, "Added chart data"));
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

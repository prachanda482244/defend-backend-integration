import { Report } from "../model/reportModel.model.js"
import { ApiError } from "../utils/ApiErrors.js"
import { ApiResponse } from "../utils/ApiResponse.js"
import { asyncHandler } from "../utils/asyncHandler.js"
const updateApproval = asyncHandler(async (req, res) => {
      const { isApproved } = req.body;
      const { reportId } = req.params;

      if (!isApproved || !reportId) {
            throw new ApiError(400, "Approval status and report ID are required");
      }
      if (!["approved", "new", "rejected"].includes(isApproved)) {
            throw new ApiError(400, "Mismatched in isApproved value")
      }

      const report = await Report.findByIdAndUpdate(
            reportId,
            {
                  $set: {
                        isQualify: isApproved
                  }
            },
            { new: true }
      );

      if (!report) {
            throw new ApiError(400, "Failed to update the report");
      }

      return res.status(200).json(
            new ApiResponse(200, report, "Report has been approved/rejected")
      );
});

const getAllReports = asyncHandler(async (req, res) => {
      let { limit = 10, page = 1, filter = "all", source = "all" } = req.query;

      limit = parseInt(limit);
      page = parseInt(page);
      const skip = (page - 1) * limit;

      let query = {};
      if (["approved", "pending", "rejected"].includes(filter)) {
            query.isQualify = filter;
      }
      if (["defent.com", "defentdiagnosis.com"].includes(source?.toLowerCase())) {
            query.source = new RegExp(`^${source}$`, 'i');
      }
      const totalReports = await Report.countDocuments(query);

      const reports = await Report.find(query)
            .skip(skip)
            .limit(limit)
            .sort({ createdAt: -1 });

      const metadata = {
            total: totalReports,
            page,
            limit,
            totalPages: Math.ceil(totalReports / limit),
            hasNextPage: skip + limit < totalReports,
            hasPrevPage: page > 1,
      };

      return res.status(200).json(
            new ApiResponse(200, { metadata, reports }, "Filtered reports information")
      );
});

const updateAllReport = asyncHandler(async (req, res) => {
      const up = await Report.updateMany(

            { isQualify: "approved" },
            { $set: { isQualify: "auto-approved" } }
      );
      if (!up) throw new ApiError(400, "failed to update")
      res.status(200).json({
            success: true,
            data: up
      })
})
export {
      updateApproval,
      getAllReports,
      updateAllReport
}
import cookieParser from "cookie-parser";
import express, { urlencoded } from "express";
import connectToDb from "./db/connectToDb.js";
import cors from "cors";
import { PORT } from "./config/constants.js";
import reportRouter from "./routes/reportRouter.route.js";
import chartRouter from "./routes/chart.route.js";
import adminRouter from "./routes/admin.route.js";
import orderRouter from "./routes/order.route.js";
import "./utils/cron.js";
const app = express();
connectToDb();

app.use(cors({ origin: "*" }));
app.use(cookieParser());
app.use(express.json({ limit: "20mb" }));
app.use(urlencoded({ extended: true, limit: "20mb" }));
app.use(express.static("public"));

app.use("/api/v1/report", reportRouter);
app.use("/api/v1/chart", chartRouter);
app.use("/api/v1/admin", adminRouter);
app.use("/api/v1/order", orderRouter);

app.get("/testing", (_, res) => {
  res.status(200).json({
    success: true,
    data: [
      {
        name: "Something",
      },
    ],
    message: "Data fetched",
  });
});
app.listen(PORT, () => {
  console.log(`Server is running on ${PORT}`);
});

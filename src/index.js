import cookieParser from "cookie-parser";
import express, { urlencoded } from "express";
import connectToDb from "./db/connectToDb.js";
import cors from "cors";
import { PORT } from "./config/constants.js";
import reportRouter from "./routes/reportRouter.route.js";
const app = express();
connectToDb();

app.use(cors({ origin: "*" }));
app.use(cookieParser());
app.use(express.json({ limit: "20mb" }));
app.use(urlencoded({ extended: true, limit: "20mb" }));
app.use(express.static("public"));

app.use("/api/v1/report", reportRouter);

app.get("/testing", (req, res) => {
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

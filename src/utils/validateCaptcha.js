import axios from "axios";
import { ApiError } from "./ApiErrors.js"

export const verifyCaptcha = async (token) => {
      if (!token) throw new ApiError(404, "Captcha token not found")
      const verifyUrl = `https://www.google.com/recaptcha/api/siteverify`;
      try {
            const { data } = await axios.post(verifyUrl, null, {
                  params: {
                        secret: process.env.CAPTCHA_SECRET,
                        response: token
                  }
            })
            return data
      } catch (error) {
            console.log(error, "error")
      }
}
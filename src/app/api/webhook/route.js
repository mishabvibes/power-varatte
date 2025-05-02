import connectDB from "../../../lib/db";
import Donation from "../../../models/Donation";
import Subscription from "../../../models/Subscription"; // Import Subscription model
import { NextResponse } from "next/server";
import crypto from "crypto";
import twilio from "twilio";

// Initialize Twilio client
const twilioClient = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN);

const verifySignature = (body, signature, secret) => {
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(JSON.stringify(body));
  return hmac.digest("hex") === signature;
};

export async function POST(req) {
  try {
    // Validate environment variables
    if (!process.env.RAZORPAY_WEBHOOK_SECRET || !process.env.TWILIO_PHONE_NUMBER || !process.env.TWILIO_SID || !process.env.TWILIO_AUTH_TOKEN) {
      console.error("Missing required environment variables");
      return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
    }

    await connectDB();
    const rawBody = await req.text();
    const event = JSON.parse(rawBody);
    const signature = req.headers.get("x-razorpay-signature");

    if (!verifySignature(event, signature, process.env.RAZORPAY_WEBHOOK_SECRET)) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
    }

    // Handle subscription.charged event
    if (event.event === "subscription.charged") {
      const subscriptionId = event.payload.subscription.entity.id;
      const paymentId = event.payload.payment.entity.id;
      const amount = event.payload.payment.entity.amount / 100;

      const subscription = await Subscription.findOne({ razorpaySubscriptionId: subscriptionId });
      if (!subscription || subscription.status !== "active") {
        return NextResponse.json({ received: true });
      }

      const donation = new Donation({
        donorId: subscription.donorId,
        razorpaySubscriptionId: subscriptionId,
        name: subscription.name || "Anonymous",
        phone: subscription.phone,
        amount: subscription.amount,
        period: subscription.period,
        district: subscription.district,
        panchayat: subscription.panchayat,
        planId: subscription.planId,
  email: subscription.email,
        razorpayPaymentId: paymentId,
        status: "Completed",
        method: "auto",
        paymentStatus: "paid",
        subscriptionId: subscription._id,
        type: subscription.type || "General",
      });
      await donation.save();
      console.log("Recurring donation recorded:", { paymentId, subscriptionId, amount });

      const updatedSubscription = await Subscription.findByIdAndUpdate(
        subscription._id,
        {
          createdAt: new Date(),
          lastPaymentAt: new Date(),
        },
        { new: true }
      );
      console.log("Subscription updated:", { subscriptionId });

      const fromNumber = `whatsapp:${process.env.TWILIO_PHONE_NUMBER}`;
      const toNumber = subscription.phone.startsWith("+")
        ? `whatsapp:${subscription.phone}`
        : `whatsapp:+91${subscription.phone}`;
      try {
        await twilioClient.messages.create({
          body: `Payment of ₹${amount} for your ${subscription.period} donation subscription received! Thank you for your support.`,
          from: fromNumber,
          to: toNumber,
        });
      } catch (twilioError) {
        console.error("Twilio error for subscription:", twilioError.message);
      }
      return NextResponse.json({ received: true });
    }

    // Handle payment events
    if (["payment.captured", "payment.authorized", "payment.failed"].includes(event.event)) {
      const payment = event.payload.payment.entity;
      const paymentId = payment.id;
      const amount = payment.amount / 100;
      const statusMap = {
        "payment.captured": "Completed",
        "payment.authorized": "Pending",
        "payment.failed": "Failed",
      };
      const donationStatus = statusMap[event.event];

      const { fullName, phoneNumber, donationType, district, panchayat, email, message, campaignId, boxId, instituteId } = payment.notes || {};

      let donation = await Donation.findOne({ razorpayPaymentId: paymentId });

      if (donation) {
        // Update existing donation
        donation.status = donationStatus;
        donation.amount = amount;
        donation.razorpayOrderId = payment.order_id || donation.razorpayOrderId;
        donation.updatedAt = new Date();
        await donation.save();
        console.log(`Donation updated for ${event.event}:`, { paymentId, status: donationStatus });
      } else {
        // Create new donation
        donation = new Donation({
          amount,
          type: donationType || "General",
          razorpayPaymentId: paymentId,
          razorpayOrderId: payment.order_id || null,
          campaignId: campaignId || null,
          boxId: boxId || null,
          instituteId: instituteId || null,
          name: fullName || "Anonymous",
          phone: phoneNumber || payment.contact || null,
          email: email || payment.email || null,
          district: district || null,
          panchayat: panchayat || null,
          message: message || null,
          status: donationStatus,
          method: payment.method,
          createdAt: new Date(payment.created_at * 1000),
        });
        await donation.save();
        console.log(`${event.event} donation recorded:`, { paymentId, amount, status: donationStatus });
      }

      // Send Twilio notification for one-time donations
      if (phoneNumber && ["payment.captured", "payment.failed"].includes(event.event)) {
        const toNumber = phoneNumber.startsWith("+") ? `whatsapp:${phoneNumber}` : `whatsapp:+91${phoneNumber}`;
        const messageBody =
          event.event === "payment.captured"
            ? `Thank you, ${fullName || "Donor"}, for your donation of ₹${amount}! Your support is greatly appreciated.`
            : `Your donation of ₹${amount} failed. Please try again or contact support.`;
        try {
          await twilioClient.messages.create({
            body: messageBody,
            from: `whatsapp:${process.env.TWILIO_PHONE_NUMBER}`,
            to: toNumber,
          });
        } catch (twilioError) {
          console.error(`Twilio error for ${event.event}:`, twilioError.message);
        }
      }
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    console.error("Webhook error:", error.message);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

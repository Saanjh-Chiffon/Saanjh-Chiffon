/* eslint-disable max-len */

const {onCall, HttpsError} = require("firebase-functions/v2/https");

const {initializeApp} = require("firebase-admin/app");
const {getFirestore, FieldValue} = require("firebase-admin/firestore");

const nodemailer = require("nodemailer");
const Razorpay = require("razorpay");

initializeApp();

const db = getFirestore();


// =====================================================
// WHATSAPP ORDER CONFIRMATION
// =====================================================

async function sendWhatsAppOrderConfirmation({
  phone,
  customerName,
  orderId,
  items,
  total,
  paymentMethod,
}) {
  try {
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
    const templateName = process.env.WHATSAPP_ORDER_TEMPLATE;

    if (!phoneNumberId || !accessToken || !templateName) {
      console.warn(
          "WhatsApp secrets/template not configured; skipping WhatsApp confirmation.",
      );
      return;
    }

    const recipient = String(phone || "").replace(/\D/g, "");

    if (recipient.length !== 10) {
      console.warn(
          "WhatsApp confirmation skipped: invalid Indian mobile number.",
      );
      return;
    }

    const itemSummary = (Array.isArray(items) ? items : [])
        .map((item) => `${item.name} x${item.qty}`)
        .join(", ")
        .slice(0, 900);

    const response = await fetch(
        `https://graph.facebook.com/v23.0/${phoneNumberId}/messages`,
        {
          method: "POST",

          headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },

          body: JSON.stringify({
            messaging_product: "whatsapp",

            to: `91${recipient}`,

            type: "template",

            template: {
              name: templateName,

              language: {
                code: "en_US",
              },

              components: [
                {
                  type: "body",

                  parameters: [
                    {
                      type: "text",
                      text: String(customerName || "").slice(0, 100),
                    },

                    {
                      type: "text",
                      text: String(orderId || "").slice(0, 100),
                    },

                    {
                      type: "text",
                      text: itemSummary || "Saree order",
                    },

                    {
                      type: "text",
                      text: `₹${Number(total || 0).toLocaleString(
                          "en-IN",
                      )}`,
                    },

                    {
                      type: "text",
                      text: String(paymentMethod || "ONLINE"),
                    },
                  ],
                },
              ],
            },
          }),
        },
    );

    if (!response.ok) {
      const errorText = await response.text();

      console.error(
          "WhatsApp confirmation failed:",
          response.status,
          errorText,
      );

      return;
    }

    console.log(
        "WhatsApp order confirmation sent:",
        orderId,
    );
  } catch (error) {
    // WhatsApp fail hone par order fail nahi hoga.
    console.error(
        "WhatsApp confirmation error:",
        error,
    );
  }
}


// =====================================================
// COD ORDER
// =====================================================

exports.createCodOrder = onCall(
    {
      secrets: [
        "GMAIL_EMAIL",
        "GMAIL_APP_PASSWORD",
        "WHATSAPP_PHONE_NUMBER_ID",
        "WHATSAPP_ACCESS_TOKEN",
        "WHATSAPP_ORDER_TEMPLATE",
      ],
    },

    async (request) => {
      const data = request.data || {};

      const {
        name,
        phone,
        email,
        address,
        city,
        state,
        pincode,
        items,
        clientOrderId,
      } = data;

      if (
        !name ||
        !phone ||
        !email ||
        !address ||
        !city ||
        !state ||
        !pincode
      ) {
        throw new HttpsError(
            "invalid-argument",
            "Customer details incomplete hain.",
        );
      }

      if (!/^[0-9]{10}$/.test(String(phone))) {
        throw new HttpsError(
            "invalid-argument",
            "Mobile number invalid hai.",
        );
      }

      if (!/^[0-9]{6}$/.test(String(pincode))) {
        throw new HttpsError(
            "invalid-argument",
            "Pincode invalid hai.",
        );
      }

      if (!Array.isArray(items) || items.length === 0) {
        throw new HttpsError(
            "invalid-argument",
            "Cart empty hai.",
        );
      }

      if (!clientOrderId || typeof clientOrderId !== "string") {
        throw new HttpsError(
            "invalid-argument",
            "Order request ID missing hai.",
        );
      }

      const safeClientOrderId = clientOrderId
          .replace(/[^a-zA-Z0-9_-]/g, "_")
          .slice(0, 120);

      const orderRef = db
          .collection("ORDERS")
          .doc(`COD_${safeClientOrderId}`);

      let total = 0;

      const orderItems = [];

      await db.runTransaction(async (transaction) => {
        const existingOrder = await transaction.get(orderRef);

        // Duplicate click protection
        if (existingOrder.exists) {
          const existing = existingOrder.data();

          total = Number(existing.total || 0);

          orderItems.push(
              ...(Array.isArray(existing.items) ? existing.items : []),
          );

          return;
        }

        // Read products first
        const productSnapshots = [];

        for (const item of items) {
          const productId = String(item.productId || "");
          const qty = Number(item.qty);

          if (
            !productId ||
            !Number.isInteger(qty) ||
            qty < 1
          ) {
            throw new HttpsError(
                "invalid-argument",
                "Product quantity invalid hai.",
            );
          }

          const productRef = db
              .collection("PRODUCTS")
              .doc(productId);

          const productSnap = await transaction.get(productRef);

          productSnapshots.push({
            item,
            productRef,
            productSnap,
          });
        }

        // Validate products
        for (const {item, productSnap} of productSnapshots) {
          if (!productSnap.exists) {
            throw new HttpsError(
                "not-found",
                "Product nahi mila.",
            );
          }

          const product = productSnap.data();

          const stock = Number(product.stock || 0);
          const price = Number(product.price || 0);
          const qty = Number(item.qty);

          if (stock < qty) {
            throw new HttpsError(
                "failed-precondition",
                `${product.Name || "Product"} ka stock available nahi hai.`,
            );
          }

          total += price * qty;

          orderItems.push({
            productId: String(item.productId),
            name: product.Name || "",
            price,
            qty,
          });
        }

        // Reduce stock
        for (
          const {
            productRef,
            productSnap,
            item,
          } of productSnapshots
        ) {
          const product = productSnap.data();

          const stock = Number(product.stock || 0);
          const qty = Number(item.qty);

          transaction.update(productRef, {
            stock: stock - qty,
          });
        }

        // Create order
        transaction.set(orderRef, {
          orderId: orderRef.id,

          customerName: String(name).trim(),
          phone: String(phone).trim(),
          email: String(email).trim(),

          address: String(address).trim(),
          city: String(city).trim(),
          state: String(state).trim(),
          pincode: String(pincode).trim(),

          items: orderItems,

          total,

          paymentMethod: "COD",

          paymentStatus: "pending",

          orderStatus: "pending",

          clientOrderId: safeClientOrderId,

          createdAt: FieldValue.serverTimestamp(),
        });
      });


      // =================================================
      // EMAIL
      // =================================================

      try {
        const transporter = nodemailer.createTransport({
          service: "gmail",

          auth: {
            user: process.env.GMAIL_EMAIL,
            pass: process.env.GMAIL_APP_PASSWORD,
          },
        });

        const itemsText = orderItems
            .map(
                (item) =>
                  `${item.name} - Qty: ${item.qty} - ₹${item.price}`,
            )
            .join("\n");

        // Admin email: full customer/order details
        await transporter.sendMail({
          from: process.env.GMAIL_EMAIL,
          to: process.env.GMAIL_EMAIL,
          subject: `New COD Order - ${orderRef.id}`,
          text:
            `New Saanjh order received!\n\n` +
            `Order ID: ${orderRef.id}\n\n` +
            `Customer Name: ${name}\n` +
            `Phone: ${phone}\n` +
            `Email: ${email}\n\n` +
            `Address: ${address}\n` +
            `City: ${city}\n` +
            `State: ${state}\n` +
            `Pincode: ${pincode}\n\n` +
            `Items:\n${itemsText}\n\n` +
            `Total: ₹${total}\n` +
            `Payment: COD`,
        });

        // Customer email: friendly order confirmation
        await transporter.sendMail({
          from: process.env.GMAIL_EMAIL,
          to: email,
          subject: `Congratulations! Your Saanjh order is placed - ${orderRef.id}`,
          text:
            `Congratulations, ${name}! 🎉\n\n` +
            `Your order has been placed successfully with Saanjh Chiffon.\n\n` +
            `Order ID: ${orderRef.id}\n\n` +
            `Order Summary:\n${itemsText}\n\n` +
            `Total: ₹${total}\n` +
            `Payment Method: Cash on Delivery (COD)\n\n` +
            `Delivery Address:\n${address}, ${city}, ${state} - ${pincode}\n\n` +
            `Thank you for choosing Saanjh Chiffon. We will keep you updated on your order.\n\n` +
            `With love,\nTeam Saanjh Chiffon`,
        });
      } catch (emailError) {
        console.error(
            "Order email failed:",
            emailError,
        );
      }


      // =================================================
      // WHATSAPP - COD
      // =================================================

      await sendWhatsAppOrderConfirmation({
        phone,

        customerName: name,

        orderId: orderRef.id,

        items: orderItems,

        total,

        paymentMethod: "COD",
      });


      return {
        success: true,

        orderId: orderRef.id,

        total,
      };
    },
);


// =====================================================
// RAZORPAY ORDER
// =====================================================

exports.createRazorpayOrder = onCall(
    {
      secrets: [
        "RAZORPAY_KEY_ID",
        "RAZORPAY_KEY_SECRET",
      ],
    },

    async (request) => {
      const data = request.data || {};

      const total = Number(data.total);

      const clientOrderId =
        String(data.clientOrderId || "").trim();

      if (!Number.isFinite(total) || total <= 0) {
        throw new HttpsError(
            "invalid-argument",
            "Invalid order total.",
        );
      }

      if (!clientOrderId) {
        throw new HttpsError(
            "invalid-argument",
            "Order request ID missing hai.",
        );
      }

      const safeClientOrderId = clientOrderId
          .replace(/[^a-zA-Z0-9_-]/g, "_")
          .slice(0, 120);

      const intentRef = db
          .collection("PAYMENT_INTENTS")
          .doc(`RP_${safeClientOrderId}`);


      // Existing Razorpay order
      const existingIntent =
        await intentRef.get();

      if (
        existingIntent.exists &&
        existingIntent.data().razorpayOrderId
      ) {
        const existing = existingIntent.data();

        return {
          success: true,

          keyId:
            process.env.RAZORPAY_KEY_ID,

          orderId:
            existing.razorpayOrderId,

          amount:
            existing.amount,

          currency:
            existing.currency,
        };
      }


      const razorpay = new Razorpay({
        key_id:
          process.env.RAZORPAY_KEY_ID,

        key_secret:
          process.env.RAZORPAY_KEY_SECRET,
      });


      try {
        const order =
          await razorpay.orders.create({
            amount:
              Math.round(total * 100),

            currency: "INR",

            receipt:
              `saanjh_${Date.now()}`,
          });


        await intentRef.set(
            {
              clientOrderId:
                safeClientOrderId,

              razorpayOrderId:
                order.id,

              amount:
                order.amount,

              currency:
                order.currency,

              createdAt:
                FieldValue.serverTimestamp(),
            },
            {
              merge: true,
            },
        );


        return {
          success: true,

          keyId:
            process.env.RAZORPAY_KEY_ID,

          orderId:
            order.id,

          amount:
            order.amount,

          currency:
            order.currency,
        };
      } catch (error) {
        console.error(
            "Razorpay order creation failed:",
            error,
        );

        throw new HttpsError(
            "internal",
            "Unable to create Razorpay order.",
        );
      }
    },
);


// =====================================================
// VERIFY RAZORPAY PAYMENT
// =====================================================

/* eslint-disable camelcase */

exports.verifyRazorpayPayment = onCall(
    {
      secrets: [
        "RAZORPAY_KEY_SECRET",
        "GMAIL_EMAIL",
        "GMAIL_APP_PASSWORD",
        "WHATSAPP_PHONE_NUMBER_ID",
        "WHATSAPP_ACCESS_TOKEN",
        "WHATSAPP_ORDER_TEMPLATE",
      ],
    },

    async (request) => {
      const data = request.data || {};

      const {
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature,

        name,
        phone,
        email,

        address,
        city,
        state,
        pincode,

        items,
        total,

        clientOrderId,
      } = data;


      if (
        !razorpay_order_id ||
        !razorpay_payment_id ||
        !razorpay_signature
      ) {
        throw new HttpsError(
            "invalid-argument",
            "Payment details incomplete.",
        );
      }


      if (
        !name ||
        !phone ||
        !email ||
        !address ||
        !city ||
        !state ||
        !pincode ||
        !Array.isArray(items) ||
        !items.length ||
        typeof total !== "number"
      ) {
        throw new HttpsError(
            "invalid-argument",
            "Customer or order details incomplete.",
        );
      }


      if (
        !clientOrderId ||
        typeof clientOrderId !== "string"
      ) {
        throw new HttpsError(
            "invalid-argument",
            "Order request ID missing hai.",
        );
      }


      const safeClientOrderId =
        clientOrderId
            .replace(/[^a-zA-Z0-9_-]/g, "_")
            .slice(0, 120);


      const idempotencyRef =
        db
            .collection("ORDERS")
            .doc(`ONLINE_${safeClientOrderId}`);


      // Already completed payment
      const existingOrder =
        await idempotencyRef.get();

      if (existingOrder.exists) {
        return {
          success: true,

          orderId:
            existingOrder.data().orderId ||
            idempotencyRef.id,
        };
      }


      const crypto = require("crypto");


      const generatedSignature =
        crypto
            .createHmac(
                "sha256",
                process.env.RAZORPAY_KEY_SECRET,
            )
            .update(
                `${razorpay_order_id}|${razorpay_payment_id}`,
            )
            .digest("hex");


      if (
        generatedSignature !==
        razorpay_signature
      ) {
        throw new HttpsError(
            "permission-denied",
            "Payment verification failed.",
        );
      }


      const orderRef =
        idempotencyRef;


      try {
        await db.runTransaction(
            async (transaction) => {
              const existing =
                await transaction.get(orderRef);

              if (existing.exists) {
                return;
              }


              // Read products first
              const productSnapshots = [];


              for (const item of items) {
                const productRef =
                  db
                      .collection("PRODUCTS")
                      .doc(item.productId);

                const productSnap =
                  await transaction.get(
                      productRef,
                  );

                productSnapshots.push({
                  item,
                  productRef,
                  productSnap,
                });
              }


              // Validate stock
              for (
                const {
                  item,
                  productSnap,
                } of productSnapshots
              ) {
                if (!productSnap.exists) {
                  throw new HttpsError(
                      "not-found",
                      `Product not found: ${item.name}`,
                  );
                }


                const productData =
                  productSnap.data();

                const currentStock =
                  Number(
                      productData.stock || 0,
                  );

                const quantity =
                  Number(item.qty || 0);


                if (
                  quantity <= 0 ||
                  currentStock < quantity
                ) {
                  throw new HttpsError(
                      "failed-precondition",
                      `Stock not available for ${item.name}`,
                  );
                }
              }


              // Reduce stock
              for (
                const {
                  productRef,
                  productSnap,
                  item,
                } of productSnapshots
              ) {
                const productData =
                  productSnap.data();

                const currentStock =
                  Number(
                      productData.stock || 0,
                  );

                const quantity =
                  Number(item.qty || 0);


                transaction.update(
                    productRef,

                    {
                      stock:
                        currentStock -
                        quantity,
                    },
                );
              }


              // Save order
              transaction.set(
                  orderRef,

                  {
                    name,

                    phone,

                    email,

                    address,

                    city,

                    state,

                    pincode,

                    items,

                    total,

                    paymentMethod:
                      "ONLINE",

                    paymentStatus:
                      "PAID",

                    razorpayOrderId:
                      razorpay_order_id,

                    razorpayPaymentId:
                      razorpay_payment_id,

                    createdAt:
                      FieldValue.serverTimestamp(),

                    status:
                      "PLACED",

                    clientOrderId:
                      safeClientOrderId,
                  },
              );
            },
        );


        // =================================================
        // EMAIL - ONLINE PAYMENT
        // =================================================
        try {
          const transporter = nodemailer.createTransport({
            service: "gmail",
            auth: {
              user: process.env.GMAIL_EMAIL,
              pass: process.env.GMAIL_APP_PASSWORD,
            },
          });

          const itemsText = items
              .map((item) => `${item.name} - Qty: ${item.qty} - ₹${item.price}`)
              .join("\n");

          await transporter.sendMail({
            from: process.env.GMAIL_EMAIL,
            to: process.env.GMAIL_EMAIL,
            subject: `New Online Order - ${orderRef.id}`,
            text:
              `New Saanjh order received!\n\n` +
              `Order ID: ${orderRef.id}\n\n` +
              `Customer Name: ${name}\n` +
              `Phone: ${phone}\n` +
              `Email: ${email}\n\n` +
              `Address: ${address}\n` +
              `City: ${city}\n` +
              `State: ${state}\n` +
              `Pincode: ${pincode}\n\n` +
              `Items:\n${itemsText}\n\n` +
              `Total: ₹${total}\n` +
              `Payment: Online (PAID)`,
          });

          await transporter.sendMail({
            from: process.env.GMAIL_EMAIL,
            to: email,
            subject: `Congratulations! Your Saanjh order is placed - ${orderRef.id}`,
            text:
              `Congratulations, ${name}! 🎉\n\n` +
              `Your order has been placed successfully with Saanjh Chiffon.\n\n` +
              `Order ID: ${orderRef.id}\n\n` +
              `Order Summary:\n${itemsText}\n\n` +
              `Total: ₹${total}\n` +
              `Payment Method: Online Payment (Paid)\n\n` +
              `Delivery Address:\n${address}, ${city}, ${state} - ${pincode}\n\n` +
              `Thank you for choosing Saanjh Chiffon. We will keep you updated on your order.\n\n` +
              `With love,\nTeam Saanjh Chiffon`,
          });
        } catch (emailError) {
          // Email failure must not undo a verified payment/order.
          console.error("Online order email failed:", emailError);
        }

        // =================================================
        // WHATSAPP - ONLINE PAYMENT
        // =================================================

        await sendWhatsAppOrderConfirmation({
          phone,

          customerName:
            name,

          orderId:
            orderRef.id,

          items,

          total,

          paymentMethod:
            "ONLINE",
        });


        return {
          success: true,

          orderId:
            orderRef.id,
        };
      } catch (error) {
        console.error(
            "Online order failed:",
            error,
        );


        if (error instanceof HttpsError) {
          throw error;
        }


        throw new HttpsError(
            "internal",
            "Online order could not be completed.",
        );
      }
    },
);

/* eslint-enable camelcase */
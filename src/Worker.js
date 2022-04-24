const { Transaction } = require("../models/transaction");
const axios = require('axios');
const mongoose = require("mongoose");
const http2 = require('http2');
const fs = require('fs');
const BigNumber = require("bignumber.js");

const BLOCKSTREAM_TESTNET_URI = "https://blockstream.info/testnet/api";
const BLOCKSTREAM_MAINNET_URI = "https://blockstream.info/api";

function connectDB() {
    return mongoose
        .connect("mongodb://localhost:27017/nguwalletpns", {
            useNewUrlParser: true,
            useUnifiedTopology: true,
            dbName: "nguwalletpns",
        })

};

async function getTransactionDetailByAddress(address, isTestnet) {
    try {
        const result = await axios.get(`${isTestnet ? BLOCKSTREAM_TESTNET_URI : BLOCKSTREAM_MAINNET_URI}/address/${address}/txs`);
        if (result && result.data) {
            return result.data;
        }
        return [];
    }
    catch (ex) {
        console.log(`Error getting transactions for address: ${address}. Exception is ${ex}`);
    }
}

async function getTransactionDetailByTxId(txId, isTestnet) {
    const result = await axios.get(`${isTestnet ? BLOCKSTREAM_TESTNET_URI : BLOCKSTREAM_MAINNET_URI}/tx/${txId}`);
    if (result && result.data) {
        return result.data;
    }
    return null;
}

function getRecievedAmount(address, tx) {
    let amount = 0;
    for (const vout of tx.vout) {
        if (vout.scriptpubkey_address === address) {
            amount += vout.value;
        }
    }

    return amount;
}

function satoshiToBTC(satoshi) {
    return new BigNumber(satoshi).dividedBy(100000000).toString(10);
}

function sendNotification(txDetail) {
    console.log('send notification')

    const title = txDetail?.transaction?.isBroadcasted ? 'Transaction Sent' : 'Recieved Transaction';
    const btc = satoshiToBTC(txDetail?.amount);
    const body = txDetail?.transaction?.isBroadcasted ? `Withdrawn ${btc} BTC` : `Recieved Transaction ${btc} BTC`;
    const apnsPayload = {
        aps: {
            badge: 1,
            alert: {
                title: title,
                body: body,
            },
            sound: "default",
        },
        walletId: txDetail?.transaction.walletId,
    };

    const publicKey = fs.readFileSync("./config/apns-dev.pem");

    const pemBuffer = Buffer.from(publicKey, "hex");
    const client = http2.connect("https://api.sandbox.push.apple.com", {
        key: pemBuffer,
        cert: pemBuffer,
    });

    client.on("error", (err) => console.error(err));

    const headers = {
        ":method": "POST",
        "apns-topic": '',
        "apns-collapse-id": txDetail?.transaction?.address,
        "apns-expiration": Math.floor(+new Date() / 1000 + 3600 * 24),
        ":scheme": "https",
        ":path": "/3/device/" + txDetail?.transaction?.token,
    };

    const request = client.request(headers);

    let responseJson = {};
    request.on("response", (headers, flags) => {
        for (const name in headers) {
            responseJson[name] = headers[name];
        }
    });
    request.on("error", (err) => {
        console.error("Apple push error:", err);

        const responseJson = {};
        responseJson["error"] = err;
        client.close();
    });

    request.setEncoding("utf8");

    let data = "";
    request.on("data", (chunk) => {
        data += chunk;
    });

    request.write(JSON.stringify(apnsPayload));

    request.on("end", () => {
        if (Object.keys(responseJson).length === 0) {
            return;
        }
        responseJson["data"] = data;
        client.close();
        console.log(responseJson);
    });
    request.end();
}

async function processTransactions() {
    console.log('start processing transaction');
    const txs = await Transaction.find() || [];
    console.log(`pulled ${txs.length} transactions`);
    if (txs && txs.length === 0) {
        return;
    }

    let addressesToDelete = [];
    let addressesToSendNotification = [];

    for (const transaction of txs) {
        if (!transaction.isBroadcasted) {
            const addressTxs = await getTransactionDetailByAddress(transaction.address, transaction.isTestnet) || [];
            if (addressTxs.length > 0) {
                for (const tx of addressTxs) {
                    if (tx) {
                        const amount = getRecievedAmount(transaction.address, tx);
                        addressesToSendNotification.push({ transaction: transaction, amount: amount, txId: tx.txId });
                        addressesToDelete.push(transaction._id);
                    }
                }
            }
        }

        if (transaction.isBroadcasted) {
            const tx = await getTransactionDetailByTxId(transaction.txId, transaction.isTestnet) || [];
            if (tx) {
                const amount = getRecievedAmount(transaction.address, tx);
                addressesToSendNotification.push({ transaction: transaction, amount: -amount, txId: tx.txId });
                addressesToDelete.push(transaction._id);
            }
        }
    }

    if (addressesToDelete.length > 0) {
        await Transaction.deleteMany({ _id: { $in: addressesToDelete } });
    }

    if (addressesToSendNotification.length > 0) {
        for (const tx of addressesToSendNotification) {
            sendNotification(tx);
        }
    }
}

async function checkConfirmationStatusForTransactions() {
    await processTransactions();
    await new Promise(res => setTimeout(res, 100000))
}

(async () => {
    connectDB()
        .then(async () => {
            console.log("Connected to MongoDB...");
            while (true) {
                console.log(Date.now());
                await checkConfirmationStatusForTransactions();
            }
        })
        .catch((err) => console.error("Could not connect to MongoDB.." + err));;

})()
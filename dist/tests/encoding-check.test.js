/**
 * Test to verify viem's encodeFunctionData produces correct ABI encoding
 * for the V3 SwapRouter exactInputSingle function.
 */
import { describe, it, expect } from "vitest";
import { encodeFunctionData } from "viem";
import { V3_SWAP_ROUTER_ABI } from "../src/lib/abis/uniswap-v3.js";
describe("exactInputSingle ABI encoding", () => {
    it("should produce the same calldata as cast/solidity ABI encoding", () => {
        const data = encodeFunctionData({
            abi: V3_SWAP_ROUTER_ABI,
            functionName: "exactInputSingle",
            args: [
                {
                    tokenIn: "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9",
                    tokenOut: "0x93e62845c1dd5822ebc807ab71a5fb750decd15a",
                    fee: 3000,
                    recipient: "0x0000000000000000000000000000000000000001",
                    deadline: 99999999999n,
                    amountIn: 1000000n,
                    amountOutMinimum: 0n,
                    sqrtPriceLimitX96: 0n,
                },
            ],
        });
        // Expected output from `cast calldata` (standard ABI encoding):
        // selector = 0x414bf389
        // then 8 words for the 8 tuple fields, inline (no offset pointer)
        const expected = "0x414bf389" +
            "00000000000000000000000009bc4e0d864854c6afb6eb9a9cdf58ac190d0df9" + // tokenIn
            "00000000000000000000000093e62845c1dd5822ebc807ab71a5fb750decd15a" + // tokenOut
            "0000000000000000000000000000000000000000000000000000000000000bb8" + // fee
            "0000000000000000000000000000000000000000000000000000000000000001" + // recipient
            "000000000000000000000000000000000000000000000000000000174876e7ff" + // deadline
            "00000000000000000000000000000000000000000000000000000000000f4240" + // amountIn
            "0000000000000000000000000000000000000000000000000000000000000000" + // amountOutMinimum
            "0000000000000000000000000000000000000000000000000000000000000000"; // sqrtPriceLimitX96
        // Total: 4 + 8*32 = 260 bytes = 520 hex chars + 2 for 0x prefix = 522
        expect(expected.length).toBe(522);
        // Compare lengths
        console.log("viem length:", data.length);
        console.log("cast length:", expected.length);
        // If viem adds an extra offset word, data.length would be 522 + 64 = 586
        if (data.length !== expected.length) {
            console.log("LENGTH MISMATCH! viem has extra bytes:", data.length - expected.length, "hex chars =", (data.length - expected.length) / 2, "bytes");
            // Show word-by-word comparison
            const viemBody = data.slice(10);
            const expBody = expected.slice(10);
            const maxWords = Math.ceil(Math.max(viemBody.length, expBody.length) / 64);
            for (let i = 0; i < maxWords; i++) {
                const vw = viemBody.slice(i * 64, (i + 1) * 64) || "(missing)";
                const ew = expBody.slice(i * 64, (i + 1) * 64) || "(missing)";
                const match = vw.toLowerCase() === ew.toLowerCase() ? "OK" : "DIFF";
                console.log(`  Word ${i} [${match}]: viem=0x${vw}  cast=0x${ew}`);
            }
        }
        expect(data.toLowerCase()).toBe(expected.toLowerCase());
    });
    it("should use selector 0x414bf389 (SwapRouter V1 with deadline)", () => {
        const data = encodeFunctionData({
            abi: V3_SWAP_ROUTER_ABI,
            functionName: "exactInputSingle",
            args: [
                {
                    tokenIn: "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9",
                    tokenOut: "0x93e62845c1dd5822ebc807ab71a5fb750decd15a",
                    fee: 3000,
                    recipient: "0x0000000000000000000000000000000000000001",
                    deadline: 99999999999n,
                    amountIn: 1000000n,
                    amountOutMinimum: 0n,
                    sqrtPriceLimitX96: 0n,
                },
            ],
        });
        const selector = data.slice(0, 10);
        console.log("Selector:", selector);
        expect(selector).toBe("0x414bf389");
    });
});

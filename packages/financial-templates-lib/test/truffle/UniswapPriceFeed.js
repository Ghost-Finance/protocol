const { toWei, toBN } = web3.utils;
const winston = require("winston");

const { UniswapPriceFeed } = require("../../src/price-feed/UniswapPriceFeed");
const { mineTransactionsAtTime, MAX_SAFE_JS_INT } = require("@uma/common");
const { delay } = require("../../src/helpers/delay.js");
const { getTruffleContract } = require("@uma/core");

const CONTRACT_VERSION = "latest";

const UniswapMock = getTruffleContract("UniswapMock", web3, CONTRACT_VERSION);
const Uniswap = getTruffleContract("Uniswap", web3, CONTRACT_VERSION);

contract("UniswapPriceFeed.js", function(accounts) {
  const owner = accounts[0];

  let uniswapMock;
  let uniswapPriceFeed;
  let mockTime = 0;
  let dummyLogger;

  beforeEach(async function() {
    uniswapMock = await UniswapMock.new({ from: owner });

    // The UniswapPriceFeed does not emit any info `level` events.  Therefore no need to test Winston outputs.
    // DummyLogger will not print anything to console as only capture `info` level events.
    dummyLogger = winston.createLogger({
      level: "info",
      transports: [new winston.transports.Console()]
    });

    uniswapPriceFeed = new UniswapPriceFeed(
      dummyLogger,
      Uniswap.abi,
      web3,
      uniswapMock.address,
      3600,
      3600,
      () => mockTime,
      false
    );
  });

  it("Basic current price", async function() {
    await uniswapMock.setPrice(toWei("2"), toWei("1"));
    await uniswapPriceFeed.update();

    assert.equal(uniswapPriceFeed.getLastBlockPrice().toString(), toWei("0.5"));
    assert.equal(uniswapPriceFeed.getLastUpdateTime(), mockTime);
    assert.equal(uniswapPriceFeed.getLookback(), 3600);
  });

  it("Correctly selects most recent price", async function() {
    await uniswapMock.setPrice(toWei("1"), toWei("1"));
    await uniswapMock.setPrice(toWei("2"), toWei("1"));
    await uniswapMock.setPrice(toWei("4"), toWei("1"));
    // Add an invalid price as the most recent price, which should be ignored.
    await uniswapMock.setPrice(toWei("0"), toWei("1"));
    await uniswapPriceFeed.update();

    assert.equal(uniswapPriceFeed.getLastBlockPrice().toString(), toWei("0.25"));
  });

  it("Selects most recent price in same block", async function() {
    // Just use current system time because the time doesn't matter.
    const time = Math.round(new Date().getTime() / 1000);

    const transactions = [
      uniswapMock.contract.methods.setPrice(toWei("1"), toWei("1")),
      uniswapMock.contract.methods.setPrice(toWei("2"), toWei("1")),
      uniswapMock.contract.methods.setPrice(toWei("4"), toWei("1"))
    ];

    // Ensure all are included in the same block
    const [receipt1, receipt2, receipt3] = await mineTransactionsAtTime(web3, transactions, time, owner);
    assert.equal(receipt2.blockNumber, receipt1.blockNumber);
    assert.equal(receipt3.blockNumber, receipt1.blockNumber);

    // Update the PF and ensure the price it gives is the last price in the block.
    await uniswapPriceFeed.update();
    assert.equal(uniswapPriceFeed.getLastBlockPrice().toString(), toWei("0.25"));
  });

  it("No price or only invalid prices", async function() {
    await uniswapPriceFeed.update();

    assert.equal(uniswapPriceFeed.getLastBlockPrice(), null);
    assert.equal(uniswapPriceFeed.getCurrentPrice(), null);

    await uniswapMock.setPrice(toWei("0"), toWei("1"));
    assert.equal(uniswapPriceFeed.getLastBlockPrice(), null);
    assert.equal(uniswapPriceFeed.getCurrentPrice(), null);
  });

  // Basic test to verify TWAP (non simulated time).
  it("Basic 2-price TWAP", async function() {
    // Update the prices with a small amount of time between.
    const result1 = await uniswapMock.setPrice(toWei("1"), toWei("1"));
    await delay(1);
    // Invalid price should be ignored.
    await uniswapMock.setPrice(toWei("0"), toWei("1"));
    const result2 = await uniswapMock.setPrice(toWei("2"), toWei("1"));

    const getBlockTime = async result => {
      return (await web3.eth.getBlock(result.receipt.blockNumber)).timestamp;
    };

    // Grab the exact blocktimes.
    const time1 = await getBlockTime(result1);
    const time2 = await getBlockTime(result2);
    mockTime = time2 + 1;

    // Allow the library to compute the TWAP.
    await uniswapPriceFeed.update();

    const totalTime = mockTime - time1;
    const weightedPrice1 = toBN(toWei("1")).muln(time2 - time1);
    const weightedPrice2 = toBN(toWei("0.5")); // 0.5 * 1 second since the mockTime is one second past time2.

    // Compare the TWAPs.
    assert.equal(
      uniswapPriceFeed.getCurrentPrice().toString(),
      weightedPrice1
        .add(weightedPrice2)
        .divn(totalTime)
        .toString()
    );
  });

  it("All events before window", async function() {
    await uniswapMock.setPrice(toWei("1"), toWei("1"));
    await uniswapMock.setPrice(toWei("2"), toWei("1"));
    await uniswapMock.setPrice(toWei("4"), toWei("1"));

    // Set the mock time to very far in the future.
    mockTime = MAX_SAFE_JS_INT;

    await uniswapPriceFeed.update();

    // Expect that the TWAP is just the most recent price, since that was the price throughout the current window.
    assert.equal(uniswapPriceFeed.getCurrentPrice().toString(), toWei("0.25"));
  });

  it("All events after window", async function() {
    await uniswapMock.setPrice(toWei("1"), toWei("1"));
    await uniswapMock.setPrice(toWei("2"), toWei("1"));
    await uniswapMock.setPrice(toWei("4"), toWei("1"));

    // Set the mock time to very far in the past.
    mockTime = 5000;

    await uniswapPriceFeed.update();

    // Since all the events are past our window, there is no valid price, and the TWAP should return null.
    assert.equal(uniswapPriceFeed.getCurrentPrice(), null);
  });

  it("One event within window, several before", async function() {
    // Offset all times from the current wall clock time so we don't mess up ganache future block times too badly.
    const currentTime = Math.round(new Date().getTime() / 1000);

    // Set prices before the T-3600 window; only the most recent one should be counted.
    await mineTransactionsAtTime(
      web3,
      [uniswapMock.contract.methods.setPrice(toWei("1"), toWei("4"))],
      currentTime - 7300,
      owner
    );
    await mineTransactionsAtTime(
      web3,
      [uniswapMock.contract.methods.setPrice(toWei("1"), toWei("2"))],
      currentTime - 7200,
      owner
    );

    // Set a price within the T-3600 window
    await mineTransactionsAtTime(
      web3,
      [uniswapMock.contract.methods.setPrice(toWei("1"), toWei("1"))],
      currentTime - 1800,
      owner
    );

    // Prices after the TWAP window should be ignored.
    await mineTransactionsAtTime(
      web3,
      [uniswapMock.contract.methods.setPrice(toWei("1"), toWei("8"))],
      currentTime + 1,
      owner
    );

    mockTime = currentTime;
    await uniswapPriceFeed.update();

    // The TWAP price should be the TWAP of the last price before the TWAP window and the single price
    // within the window:
    // - latest price before TWAP window: 2
    // - single price exactly 50% through the window: 1
    // - TWAP: 2 * 0.5 + 1 * 0.5 = 1.5
    assert.equal(uniswapPriceFeed.getCurrentPrice(), toWei("1.5"));
  });

  it("Basic historical TWAP", async function() {
    // Offset all times from the current wall clock time so we don't mess up ganache future block times too badly.
    const currentTime = Math.round(new Date().getTime() / 1000);

    // Historical window starts 2 hours ago. Set the price to 100 before the beginning of the window (2.5 hours before currentTime)
    await mineTransactionsAtTime(
      web3,
      [uniswapMock.contract.methods.setPrice(toWei("1"), toWei("100"))],
      currentTime - 7200,
      owner
    );

    // At an hour and a half ago, set the price to 90.
    await mineTransactionsAtTime(
      web3,
      [uniswapMock.contract.methods.setPrice(toWei("1"), toWei("90"))],
      currentTime - 5400,
      owner
    );

    // At an hour and a half ago - 1 second, set the price to an invalid one. This should be ignored.
    await mineTransactionsAtTime(
      web3,
      [uniswapMock.contract.methods.setPrice(toWei("0"), toWei("1"))],
      currentTime - 5399,
      owner
    );

    // At an hour ago, set the price to 80.
    await mineTransactionsAtTime(
      web3,
      [uniswapMock.contract.methods.setPrice(toWei("1"), toWei("80"))],
      currentTime - 3600,
      owner
    );

    // At half an hour ago, set the price to 70.
    await mineTransactionsAtTime(
      web3,
      [uniswapMock.contract.methods.setPrice(toWei("1"), toWei("70"))],
      currentTime - 1800,
      owner
    );

    mockTime = currentTime;

    await uniswapPriceFeed.update();

    // The historical TWAP for 1 hour ago (the earliest allowed query) should be 100 for the first half and then 90 for the second half -> 95.
    assert.equal((await uniswapPriceFeed.getHistoricalPrice(currentTime - 3600)).toString(), toWei("95"));

    // The historical TWAP for 45 mins ago should be 100 for the first quarter, 90 for the middle half, and 80 for the last quarter -> 90.
    assert.equal((await uniswapPriceFeed.getHistoricalPrice(currentTime - 2700)).toString(), toWei("90"));

    // The historical TWAP for 30 minutes ago should be 90 for the first half and then 80 for the second half -> 85.
    assert.equal((await uniswapPriceFeed.getHistoricalPrice(currentTime - 1800)).toString(), toWei("85"));

    // The historical TWAP for 15 minutes ago should be 90 for the first quarter, 80 for the middle half, and 70 for the last quarter -> 80.
    assert.equal((await uniswapPriceFeed.getHistoricalPrice(currentTime - 900)).toString(), toWei("80"));

    // The historical TWAP for now should be 80 for the first half and then 70 for the second half -> 75.
    assert.equal((await uniswapPriceFeed.getHistoricalPrice(currentTime)).toString(), toWei("75"));
  });

  it("Historical time earlier than TWAP window", async function() {
    const currentTime = Math.round(new Date().getTime() / 1000);
    mockTime = currentTime;

    // Set a price within the TWAP window so that if the historical time requested were within
    // the window, then there wouldn't be an error.
    await mineTransactionsAtTime(
      web3,
      [uniswapMock.contract.methods.setPrice(toWei("1"), toWei("1"))],
      currentTime - 3600,
      owner
    );
    await uniswapPriceFeed.update();

    // The TWAP lookback is 1 hour (3600 seconds). The price feed should throw if we attempt to go any further back than that.
    assert.equal(await uniswapPriceFeed.getHistoricalPrice(currentTime - 3599), toWei("1"));
    assert.isTrue(await uniswapPriceFeed.getHistoricalPrice(currentTime - 3601).catch(() => true));
  });

  it("Invert price", async function() {
    uniswapPriceFeed = new UniswapPriceFeed(
      dummyLogger,
      Uniswap.abi,
      web3,
      uniswapMock.address,
      3600,
      3600,
      () => mockTime,
      true
    );

    await uniswapMock.setPrice(toWei("2"), toWei("1"));
    await uniswapPriceFeed.update();

    assert.equal(uniswapPriceFeed.getLastBlockPrice().toString(), toWei("2"));
  });

  describe("Can return non-18 precision prices", function() {
    let scaleDownPriceFeed, scaleUpPriceFeed;
    beforeEach(async function() {
      // Here we specify that the pool is reporting a 6 decimal precision price, and we want prices in
      // 12 decimals. This should scale up prices by 10e6.
      scaleUpPriceFeed = new UniswapPriceFeed(
        dummyLogger,
        Uniswap.abi,
        web3,
        uniswapMock.address,
        3600,
        3600,
        () => mockTime,
        false,
        6,
        12
      );
      // Here we specify that the balancer pool is returning a 6 decimal precision price, and we want prices in
      // 4 decimals. This should scale down prices by 10e2.
      scaleDownPriceFeed = new UniswapPriceFeed(
        dummyLogger,
        Uniswap.abi,
        web3,
        uniswapMock.address,
        3600,
        3600,
        () => mockTime,
        false,
        6,
        4
      );
    });
    it("Basic 2 price TWAP", async function() {
      // Update the prices with a small amount of time between.
      const result1 = await uniswapMock.setPrice(toWei("1"), toWei("1"));
      await delay(1);
      const result2 = await uniswapMock.setPrice(toWei("2"), toWei("1"));

      const getBlockTime = async result => {
        return (await web3.eth.getBlock(result.receipt.blockNumber)).timestamp;
      };

      // Grab the exact blocktimes.
      const time1 = await getBlockTime(result1);
      const time2 = await getBlockTime(result2);
      mockTime = time2 + 1;

      // Allow the library to compute the TWAP.
      await scaleUpPriceFeed.update();
      await scaleDownPriceFeed.update();

      const totalTime = mockTime - time1;
      const weightedPrice1 = toBN(toWei("1")).muln(time2 - time1);
      const weightedPrice2 = toBN(toWei("0.5")); // 0.5 * 1 second since the mockTime is one second past time2.

      // Compare the scaled TWAPs.
      assert.equal(
        scaleUpPriceFeed.getCurrentPrice().toString(),
        weightedPrice1
          .add(weightedPrice2)
          .divn(totalTime)
          .muln(10 ** 6) // scale UP by 10e6
          .toString()
      );
      assert.equal(
        scaleDownPriceFeed.getCurrentPrice().toString(),
        weightedPrice1
          .add(weightedPrice2)
          .divn(totalTime)
          .divn(10 ** 2) // scale DOWN by 10e2
          .toString()
      );
    });
    it("Basic historical TWAP", async function() {
      // Offset all times from the current wall clock time so we don't mess up ganache future block times too badly.
      const currentTime = Math.round(new Date().getTime() / 1000);

      // Historical window starts 2 hours ago. Set the price to 100 before the beginning of the window (2.5 hours before currentTime)
      await mineTransactionsAtTime(
        web3,
        [uniswapMock.contract.methods.setPrice(toWei("1"), toWei("100"))],
        currentTime - 7200,
        owner
      );

      // At an hour and a half ago, set the price to 90.
      await mineTransactionsAtTime(
        web3,
        [uniswapMock.contract.methods.setPrice(toWei("1"), toWei("90"))],
        currentTime - 5400,
        owner
      );

      // At an hour ago, set the price to 80.
      await mineTransactionsAtTime(
        web3,
        [uniswapMock.contract.methods.setPrice(toWei("1"), toWei("80"))],
        currentTime - 3600,
        owner
      );

      // At half an hour ago, set the price to 70.
      await mineTransactionsAtTime(
        web3,
        [uniswapMock.contract.methods.setPrice(toWei("1"), toWei("70"))],
        currentTime - 1800,
        owner
      );

      mockTime = currentTime;

      await scaleDownPriceFeed.update();
      await scaleUpPriceFeed.update();

      // The historical TWAP for 1 hour ago (the earliest allowed query) should be 100 for the first half and then 90 for the second half -> 95.
      assert.equal(
        (await scaleUpPriceFeed.getHistoricalPrice(currentTime - 3600)).toString(),
        toBN(toWei("95"))
          .muln(10 ** 6)
          .toString()
      );
      assert.equal(
        (await scaleDownPriceFeed.getHistoricalPrice(currentTime - 3600)).toString(),
        toBN(toWei("95"))
          .divn(10 ** 2)
          .toString()
      );
    });
  });
  // TODO: add the following TWAP tests using simulated block times:
  // - Some events post TWAP window, some inside window.
  // - Complex (5+ value) TWAP with events overlapping on both sides of the window.

  // TODO: add tests to ensure intra-transaction price changes are handled correctly.
});

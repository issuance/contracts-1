var Web3 = require('web3');
var web3 = new Web3(new Web3.providers.HttpProvider("http://localhost:8545"));

var BigNumber = require('bignumber.js');

function setTimeForward(timeDiff, fn) {
  return new Promise(function(accept, reject) {
    web3.currentProvider.sendAsync({
      method: "evm_increaseTime",
      params: [timeDiff],
      jsonrpc: "2.0",
      id: Date.now()
    }, function (error, result) {
      if (error) {
        reject(error);
      } else {
        accept(result);
      }
    });
  });
}

function assertThrows(promise, message, returnFn=null) {
  return promise.then(function(success) {
    // Call was successful, should have thrown
    assert.fail(true, false, message);
  }, function(error) {
    // hack for verifying throw occurred.
    assert.include(error.toString(), "invalid JUMP");
    return returnFn;
  });
}

function assertBigNumberEquality(first, second, message=null) {
  assert.equal(first.round().toString(), second.round().toString(), message);
}

function verifyEvent(log, expectedLog) {
  assert.equal(log.event, expectedLog.event);
  Object.keys(expectedLog.args).forEach(function(key, index) {
    if (log.args[key] instanceof BigNumber ||
          expectedLog.args[key] instanceof BigNumber) {
        assertBigNumberEquality(log.args[key], expectedLog.args[key]);
    } else {
      assert.equal(log.args[key], expectedLog.args[key]);
    }
  });
}

PeriodType = {
  Weekly: 0,
  Monthly: 1,
  Yearly: 2,
  FixedDate: 3
}

/*
  ACCOUNT 0: BORROWER
  ACCOUNT 1: ATTESTOR
  ACCOUNT 2: INVESTOR 1
  ACCOUNT 3: INVESTOR 2
  ACCOUNT 4: INVESTOR 3
*/

var Loan = artifacts.require("./Loan.sol");

// set timelock date for 14 days in future
var timeLockDate = web3.eth.getBlock('latest').timestamp + 14*24*3600;
const TEST_RPC_GAS_PRICE = web3.toBigNumber('100000000000');
const LOAN_TERMS = [web3.toWei(3, 'ether'), PeriodType.Monthly,
                      web3.toWei(.05, 'ether'), true, 2, timeLockDate];
contract('Loan', function(_accounts) {
  accounts = _accounts;
  loan = null;
  it("should deploy with the correct terms and RAA PK", function() {
    return Loan.new(...[accounts[1]].concat(LOAN_TERMS)).then(function(instance) {
      loan = instance;
      return loan.principal.call();
    }).then(function(principal) {
      assert.equal(principal.toNumber(), LOAN_TERMS[0]);
      return loan.periodType.call();
    }).then(function(periodType) {
      assert.equal(periodType, LOAN_TERMS[1]);
      return loan.interestRate.call();
    }).then(function(interestRate) {
      assert.equal(interestRate, LOAN_TERMS[2]);
      return loan.isInterestCompounded.call();
    }).then(function(isInterestCompounded) {
      assert.equal(isInterestCompounded, LOAN_TERMS[3]);
      return loan.termLength.call();
    }).then(function(termLength) {
      assert.equal(termLength, LOAN_TERMS[4])
      return loan.fundingPeriodTimeLock.call();
    }).then(function(fundingPeriodTimeLock) {
      assert.equal(fundingPeriodTimeLock, timeLockDate);
      return loan.borrower.call();
    }).then(function(borrower) {
      assert.equal(borrower, accounts[0]);
      return loan.attestor.call();
    }).then(function(attestor) {
      assert.equal(attestor, accounts[1]);
    });
  });

  it("should not allow an investor to fund the loan before it's been attested to", function() {
    var invalidFundTransaction =
        loan.fundLoan({from: accounts[2], value: web3.toWei(1, 'ether')});
    return assertThrows(invalidFundTransaction,
          "Should have thrown when investor funded unattested loan");
  });

  it("should allow an RAA to attest to the loan", function() {
    var ipfs_url = "/ipfs/QmdP6Hw8MnbRi2dqrdhVd1YgvgWXoteiSjBwkd5jYHhyPJ";
    var invalidAttestorTransaction =
      loan.attestToBorrower(ipfs_url, {from: accounts[4]});
    return assertThrows(invalidAttestorTransaction,
                        "should only allow the pre-set attestor to attest",
                        loan.attestationUrl.call()).then(function(attestationUrl) {
      assert.equal(attestationUrl, '0x');
      return loan.attestToBorrower(ipfs_url, {from: accounts[1]});
    }).then(function(result) {
      verifyEvent(result.logs[0], { event: "LoanAttested",
                                    args: {}
                                  });
      return loan.attestationUrl.call();
    }).then(function(attestationUrl) {
      assert.equal(web3.toAscii(attestationUrl), ipfs_url);
    });
  });

  it("should allow investor 1 to fund loan once it's been attested", function() {
    return loan.fundLoan({from: accounts[2], value: web3.toWei(1, 'ether')}).then(function(result) {
      verifyEvent(result.logs[0], { event: "Investment",
                                    args: {
                                      _from: accounts[2],
                                      _value: web3.toWei(1, 'ether')
                                    }});
      return loan.investors.call(accounts[2]);
    }).then(function(investor) {
      assert.equal(investor[0], web3.toWei(1, 'ether'));
      assert.equal(investor[1], web3.toWei(0, 'ether'));
    });
  });

  it("should allow investor 2 to fund loan and up their investment in a later tx", function() {
    return loan.fundLoan({from: accounts[11], value: web3.toWei(0.35, 'ether')}).then(function(result) {
      verifyEvent(result.logs[0], { event: "Investment",
                                    args: {
                                      _from: accounts[11],
                                      _value: web3.toWei(0.35, 'ether')
                                    }});
      return loan.investors.call(accounts[11]);
    }).then(function(investor) {
      assert.equal(investor[0], web3.toWei(0.35, 'ether'));
      assert.equal(investor[1], web3.toWei(0, 'ether'));
      return loan.fundLoan({from: accounts[11], value: web3.toWei(0.2, 'ether')});
    }).then(function(result) {
      verifyEvent(result.logs[0], { event: "Investment",
                                    args: {
                                      _from: accounts[11],
                                      _value: web3.toWei(0.2, 'ether')
                                    }});
      return loan.investors.call(accounts[11]);
    }).then(function(investor) {
      assert.equal(investor[0], web3.toWei(0.55, 'ether'));
      assert.equal(investor[1], web3.toWei(0, 'ether'));
    });
  });

  it("should not allow investors to withdraw their funds before the timelock date", function() {
    return assertThrows(loan.withdrawInvestment({from: accounts[2]}),
                        "investor 1 should not be able to withdraw before timelock");
  });

  it("should allow investor 3 to fund the remainder of the loan, refund him the \
      extra amount he sent, and forward the principal to the borrower", function() {

    var lastInvestorBalanceBefore = web3.eth.getBalance(accounts[4]);
    var borrowerBalanceBefore = web3.eth.getBalance(accounts[0]);
    var etherUsedForGas = null;
    return loan.fundLoan({from: accounts[4],
                          value: web3.toWei(3, 'ether')}).then(function(result) {
      etherUsedForGas = TEST_RPC_GAS_PRICE.times(result.receipt.gasUsed);
      verifyEvent(result.logs[0], { event: "Investment",
                                    args: {
                                      _from: accounts[4],
                                      _value: web3.toWei(1.45, 'ether')
                                    }});
      verifyEvent(result.logs[1], { event: "LoanTermBegin",
                                    args: {}
                                  });
      return loan.investors.call(accounts[4]);
    }).then(function(investor) {
      assert.equal(investor[0], web3.toWei(1.45, 'ether'));
      assert.equal(investor[1], web3.toWei(0, 'ether'));

      var lastInvestorBalanceAfter = web3.eth.getBalance(accounts[4]);
      var borrowerBalanceAfter = web3.eth.getBalance(accounts[0]);
      var lastInvestorDelta = lastInvestorBalanceBefore.minus(lastInvestorBalanceAfter).minus(etherUsedForGas);
      var borrowerDelta = borrowerBalanceAfter.minus(borrowerBalanceBefore);

      assert.equal(lastInvestorDelta, web3.toWei(1.45, 'ether'), "investor was not refunded proper amount");
      assert.equal(borrowerDelta, LOAN_TERMS[0], "balance was not transferred to borrower");
      assert.equal(web3.eth.getBalance(loan.address), 0);
    });
  });

  it("should allow a loan to be funded by an investor contributing the exact necessary amount", function() {
    var borrowerBalanceBefore = 0;
    var lastInvestorBalanceBefore = web3.eth.getBalance(accounts[7]);
    var etherUsedForGas = 0;
    return Loan.new(...[accounts[6]].concat(LOAN_TERMS), {from: accounts[5]}).then(function(instance) {
      borrowerBalanceBefore = web3.eth.getBalance(accounts[5]);
      second_loan = instance;
      var ipfs_url = "/ipfs/QmdP6Hw8MnbRi2dqrdhVd1YgvgWXoteiSjBwkd5jYHhyPJ";
      return second_loan.attestToBorrower(ipfs_url, {from: accounts[6]});
    }).then(function(tx) {
      return second_loan.principal.call();
    }).then(function(principal) {
      return second_loan.fundLoan({from: accounts[7],
                            value: web3.toWei(3, 'ether')});
    }).then(function(result) {
      etherUsedForGas += TEST_RPC_GAS_PRICE.times(result.receipt.gasUsed);
      verifyEvent(result.logs[0], { event: "Investment",
                                    args: {
                                      _from: accounts[7],
                                      _value: web3.toWei(3, 'ether')
                                    }});
      verifyEvent(result.logs[1], { event: "LoanTermBegin",
                                    args: {}
                                  });
      return second_loan.investors.call(accounts[7]);
    }).then(function(investor) {
      assert.equal(investor[0], web3.toWei(3, 'ether'));
      assert.equal(investor[1], web3.toWei(0, 'ether'));

      var lastInvestorBalanceAfter = web3.eth.getBalance(accounts[7]);
      var borrowerBalanceAfter = web3.eth.getBalance(accounts[5]);
      var lastInvestorDelta = lastInvestorBalanceBefore.minus(lastInvestorBalanceAfter).minus(etherUsedForGas);
      var borrowerDelta = borrowerBalanceAfter.minus(borrowerBalanceBefore);
      assert.equal(lastInvestorDelta, web3.toWei(3, 'ether'), "investor was not refunded proper amount");
      assert.equal(borrowerDelta, web3.toWei(3, 'ether'), "balance was not transferred to borrower");
      assert.equal(web3.eth.getBalance(second_loan.address), 0);
    })
  });

  it("should allow investors to withdraw their investment if the loan remains \
        unfunded after the timelock date", function() {
      investor_4_balance_before = 0;
      investor_5_balance_before = 0;

      return Loan.new(...[accounts[8]].concat(LOAN_TERMS),
                      {from: accounts[7]}).then(function(instance) {
        unfulfilled_loan = instance;
        var ipfs_url = "/ipfs/QmdP6Hw8MnbRi2dqrdhVd1YgvgWXoteiSjBwkd5jYHhyPJ";
        return unfulfilled_loan.attestToBorrower(ipfs_url, {from: accounts[8]});
      }).then(function(result) {
        return unfulfilled_loan.fundLoan({from: accounts[9],
                                          value: web3.toWei(1, 'ether')});
      }).then(function(result) {
        return unfulfilled_loan.fundLoan({from: accounts[10],
                                          value: web3.toWei(1, 'ether')});
      }).then(function(result) {
        investor_4_balance_before = web3.eth.getBalance(accounts[9]);
        investor_5_balance_before = web3.eth.getBalance(accounts[10]);
        return setTimeForward(15*24*3600);

/******************************************************************************
    15 DAYS LATER...
******************************************************************************/

      }).then(function(result) {
        return unfulfilled_loan.withdrawInvestment({from: accounts[9]});
      }).then(function(result) {
        var etherUsedForGas = TEST_RPC_GAS_PRICE.times(result.receipt.gasUsed);
        var investor_4_refund = web3.eth.getBalance(accounts[9])
                                        .minus(investor_4_balance_before)
                                        .plus(etherUsedForGas);

        assertBigNumberEquality(investor_4_refund, web3.toBigNumber(web3.toWei(1, 'ether')));
        return unfulfilled_loan.withdrawInvestment({from: accounts[10]});
      }).then(function(result) {
        var etherUsedForGas = TEST_RPC_GAS_PRICE.times(result.receipt.gasUsed);
        var investor_5_refund = web3.eth.getBalance(accounts[10])
                                        .minus(investor_5_balance_before)
                                        .plus(etherUsedForGas);

        assert.equal(investor_5_refund, web3.toWei(1, 'ether'));
        assert.equal(web3.eth.getBalance(unfulfilled_loan.address), 0);
      });
  });

  it("should not allow a lender to withdraw their investment if the loan is \
        funded already, even if the timelock date has passed", function() {
    return assertThrows(loan.withdrawInvestment({from: accounts[11]}),
                        "investor 2 should not be able to withdraw after loan is funded");
  });

/*
  ERC20 TOKEN STANDARD TESTS
*/

  it("should allow a lender to transfer ownership in their loan to someone else",
          function() {
    return loan.transfer(accounts[3], web3.toWei(0.33, 'ether'), {from: accounts[11]}).then(function(result) {
      return loan.investors.call(accounts[3]);
    }).then(function(new_investor) {
      assert.equal(new_investor[0], web3.toWei(0.33, 'ether'));
      return loan.investors.call(accounts[11]);
    }).then(function(old_investor) {
      assert.equal(old_investor[0], 0.22);
    })
  })

  it("should expose a totalSupply endpoint", function() {
    return loan.totalSupply().then(function(totalSupply) {
      assert.equal(totalSupply, web3.toWei(1, 'ether'));
    })
  });

  it("should expose a balanceOf endpoint", function() {
    return loan.balanceOf(accounts[3]).then(function(balance) {
      assert.equal(balanceOf, (0.55 / 3) * web3.toWei(1, 'ether'));
    })
  });

  it("should expose the transferFrom, approve, and allowance endpoints", function() {
    return assertThrows(loan.transferFrom(accounts[11], accounts[3], web3.toWei(0.22, 'ether'), {from: accounts[12]}),
      "should not allow transferFrom without approval").then(function(result) {
      return loan.approve(accounts[12], web3.toWei(0.22, 'ether'));
    }).then(function(result) {
      return loan.allowance(accounts[11], accounts[12]);
    }).then(function(allowance) {
      assert.equal(allowance, web3.toWei(0.22, 'ether'));
      return loan.transferFrom(accounts[11], accounts[3], web3.toWei(0.22), {from: accounts[12]});
    }).then(function(result) {
      return loan.balanceOf(accounts[11]);
    }).then(function(balance) {
      assert.equal(balance, 0);
      return loan.balanceOf(accounts[3]);
    }).then(function(balance) {
      assert.equal(balance, web3.toWei(0.22, 'ether'));
    });
  })


  /*
    Flow of this test is expected to go as follows:
      1. Borrower repays half of his principal + interest
      2. Investor 1 redeems his portion of the first half
      3. Investor 1 attempts to redeem again from the first half portion - THROWS
      4. Investor 2 redeems his portion of the first half
      5. Borrower repays remainder of his principal + interest
      6. Investor 1 redeems his portion of the remaining half
      7. Investor 1 attempts to redeem again though he's redeemed his full value - THROWS
      8. Investor 2 redeems his portion of the remaining half
      9. Investor 3 redeems his portion of the entire principal + interest balance.
  */

  var proration = [web3.toBigNumber('1').dividedBy('3'),
                   web3.toBigNumber('0.55').dividedBy('3'),
                   web3.toBigNumber('1.45').dividedBy('3')];

  var investor_1_balance_before = null;
  var investor_2_balance_before = null;
  var investor_3_balance_before = null;

  var etherOwed = web3.toBigNumber(1.5).times(web3.toBigNumber(1.05));
  var paybackQuantity = web3.toWei(etherOwed, 'ether');

  it("should allow a borrower to make his first monthly repayment", function() {
    return loan.payBackLoan({value: paybackQuantity}).then(function(result) {
      verifyEvent(result.logs[0], { event: "Payment",
                                    args: {
                                      _from: accounts[0],
                                      _value: paybackQuantity
                                    }});
      assertBigNumberEquality(web3.eth.getBalance(loan.address), paybackQuantity);
    });
  });

  it("should allow investor 1 to redeem his portion of the first monthly \
        payment once only", function() {
    investor_1_balance_before = web3.eth.getBalance(accounts[2]);
    return loan.redeemInvestment({from: accounts[2]}).then(function(result) {
      verifyEvent(result.logs[0], { event: "InvestmentRedeemed",
                                    args: {
                                      _to: accounts[2],
                                      _value: paybackQuantity.times(proration[0])
                                    }});
      var etherUsedForGas = TEST_RPC_GAS_PRICE.times(result.receipt.gasUsed);
      var investor_1_payout = web3.eth.getBalance(accounts[2])
                                      .minus(investor_1_balance_before)
                                      .plus(etherUsedForGas);

      assertBigNumberEquality(investor_1_payout,
                              paybackQuantity.times(proration[0]),
                              "did not prorate investor 1's payout correctly");

      return assertThrows(loan.redeemInvestment({from: accounts[2]}),
                      "should not allow investor 1 redeem when he's already \
                      redeemed his portion of this pay back.");
    })
  });

  it("should allow investor 2 to redeem her portion of the first monthly \
        payment", function() {
    investor_2_balance_before = web3.eth.getBalance(accounts[3]);
    return loan.redeemInvestment({from: accounts[3]}).then(function(result) {
      verifyEvent(result.logs[0], { event: "InvestmentRedeemed",
                                    args: {
                                      _to: accounts[3],
                                      _value: paybackQuantity.times(proration[1])
                                    }});

      var etherUsedForGas = TEST_RPC_GAS_PRICE.times(result.receipt.gasUsed);
      var investor_2_payout = web3.eth.getBalance(accounts[3])
                                      .minus(investor_2_balance_before)
                                      .plus(etherUsedForGas);
      assertBigNumberEquality(investor_2_payout, paybackQuantity.times(proration[1]));
    });
  });

  it("should allow borrower to make his final monthly payment", function() {
    return loan.payBackLoan({value: paybackQuantity}).then(function(result) {
      verifyEvent(result.logs[0], { event: "Payment",
                                    args: {
                                      _from: accounts[0],
                                      _value: paybackQuantity
                                    }});
    });
  });

  it("should allow investor 1 to redeem his portion of the final monthly \
        payment only once", function() {
    investor_1_balance_before = web3.eth.getBalance(accounts[2]);
    return loan.redeemInvestment({from: accounts[2]}).then(function(result) {
      verifyEvent(result.logs[0], { event: "InvestmentRedeemed",
                                    args: {
                                      _to: accounts[2],
                                      _value: paybackQuantity.times(proration[0])
                                    }});

      var etherUsedForGas = TEST_RPC_GAS_PRICE.times(result.receipt.gasUsed);
      var investor_1_payout = web3.eth.getBalance(accounts[2])
                                      .minus(investor_1_balance_before)
                                      .plus(etherUsedForGas);
      assertBigNumberEquality(investor_1_payout, paybackQuantity.times(proration[0]),
                    "did not prorate investor 1's second payout correctly");

      return assertThrows(loan.redeemInvestment({from: accounts[2]}),
                          "should not allow investor 1 redeem when he's already \
                          redeemed the full portion of his share of the loan");
    });
  });

  it("should allow investor 2 to redeem her portion of the final monthly \
        payment", function() {
    investor_2_balance_before = web3.eth.getBalance(accounts[3]);
    loan.redeemInvestment({from: accounts[3]}).then(function(result) {
      verifyEvent(result.logs[0], { event: "InvestmentRedeemed",
                                    args: {
                                      _to: accounts[3],
                                      _value: paybackQuantity.times(proration[1])
                                    }});
      var etherUsedForGas = TEST_RPC_GAS_PRICE.times(result.receipt.gasUsed);
      var investor_2_payout = web3.eth.getBalance(accounts[3])
                                      .minus(investor_2_balance_before)
                                      .plus(etherUsedForGas);
      assertBigNumberEquality(investor_2_payout, paybackQuantity.times(proration[1]));
    });
  });

  it("should allow investor 3 to redeem his unclaimed portion of the total two \
        monthly payments", function() {
    investor_3_balance_before = web3.eth.getBalance(accounts[4]);
    return loan.redeemInvestment({from: accounts[4]}).then(function(result) {
      verifyEvent(result.logs[0], { event: "InvestmentRedeemed",
                                    args: {
                                      _to: accounts[4],
                                      _value: paybackQuantity.times(2).times(proration[2])
                                    }});
      var etherUsedForGas = TEST_RPC_GAS_PRICE.times(result.receipt.gasUsed);
      var investor_3_payout = web3.eth.getBalance(accounts[4])
                                      .minus(investor_3_balance_before)
                                      .plus(etherUsedForGas);
      assertBigNumberEquality(investor_3_payout, paybackQuantity.times(2).times(proration[2]));
      var leftoverContractBalance = web3.eth.getBalance(loan.address);
      assert.equal(leftoverContractBalance, 0);
    });
  });
});

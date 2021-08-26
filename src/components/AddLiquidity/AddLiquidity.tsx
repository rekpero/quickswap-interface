import React, { useCallback, useEffect, useState } from 'react';
import { Box, Button, Typography } from '@material-ui/core';
import { CurrencyInput, TransactionConfirmationModal, ConfirmationModalContent, ConfirmAddModalBottom, MinimalPositionCard } from 'components';
import { makeStyles } from '@material-ui/core/styles';
import { useWalletModalToggle } from 'state/application/hooks';
import { TransactionResponse } from '@ethersproject/providers';
import { BigNumber } from '@ethersproject/bignumber';
import ReactGA from 'react-ga';
import { Currency, Token, currencyEquals, ETHER, TokenAmount, WETH } from '@uniswap/sdk';
import { ROUTER_ADDRESS } from 'constants/index';
import { useAllTokens } from 'hooks/Tokens';
import AddIcon from '@material-ui/icons/Add';
import { useActiveWeb3React } from 'hooks';
import useTransactionDeadline from 'hooks/useTransactionDeadline';
import { ApprovalState, useApproveCallback } from 'hooks/useApproveCallback';
import { Field } from 'state/mint/actions';
import { PairState } from 'data/Reserves';
import { useTransactionAdder } from 'state/transactions/hooks';
import { useDerivedMintInfo, useMintActionHandlers, useMintState } from 'state/mint/hooks';
import { useIsExpertMode, useUserSlippageTolerance } from 'state/user/hooks'
import { maxAmountSpend, addMaticToMetamask, getRouterContract, calculateSlippageAmount, calculateGasMargin } from 'utils';
import { wrappedCurrency } from 'utils/wrappedCurrency';

const useStyles = makeStyles(({ palette, breakpoints }) => ({
  exchangeSwap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    background: palette.background.default,
    border: `2px solid ${palette.primary.dark}`,
    cursor: 'pointer',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    margin: '-20px auto',
    zIndex: 2,
    position: 'relative',
    '& svg': {
      width: 32,
      height: 32,
      color: palette.primary.main
    }
  },
  swapButtonWrapper: {
    marginTop: 16,
    '& button': {
      height: 56,
      fontSize: 16,
      fontWeight: 'normal',
      '& .content': {
        display: 'flex',
        alignItems: 'center',
        '& > div': {
          color: 'white',
          marginLeft: 6
        }
      },
      width: '100%',
      '& p': {
        fontSize: 16
      }
    }
  },
  swapPrice: {
    display: 'flex',
    justifyContent: 'space-between',
    margin: '16px 8px 0',
    '& p': {
      display: 'flex',
      fontSize: 16,
      alignItems: 'center',
      '& svg': {
        marginLeft: 8,
        width: 16,
        height: 16,
        cursor: 'pointer'
      }
    }
  },
  approveButtons: {
    display: 'flex',
    justifyContent: 'space-between',
    marginBottom: 16
  }
}));

const AddLiquidity: React.FC = () => {
  const classes = useStyles();

  const { account, chainId, library } = useActiveWeb3React();

  const [ showConfirm, setShowConfirm ] = useState(false);
  const [attemptingTxn, setAttemptingTxn] = useState(false);
  const [allowedSlippage] = useUserSlippageTolerance();
  const deadline = useTransactionDeadline();
  const [txHash, setTxHash] = useState('');
  const addTransaction = useTransactionAdder();

  const { independentField, typedValue, otherTypedValue } = useMintState();
  const expertMode = useIsExpertMode();
  const {
    dependentField,
    currencies,
    pair,
    pairState,
    currencyBalances,
    parsedAmounts,
    price,
    noLiquidity,
    liquidityMinted,
    poolTokenPercentage,
    error
  } = useDerivedMintInfo();

  const pendingText = `Supplying ${parsedAmounts[Field.CURRENCY_A]?.toSignificant(6)} ${
    currencies[Field.CURRENCY_A]?.symbol
  } and ${parsedAmounts[Field.CURRENCY_B]?.toSignificant(6)} ${currencies[Field.CURRENCY_B]?.symbol}`;

  const { onFieldAInput, onFieldBInput, onCurrencySelection } = useMintActionHandlers(noLiquidity);

  const allTokens = useAllTokens();

  const maxAmounts: { [field in Field]?: TokenAmount } = [Field.CURRENCY_A, Field.CURRENCY_B].reduce(
    (accumulator, field) => {
      return {
        ...accumulator,
        [field]: maxAmountSpend(currencyBalances[field])
      }
    },
    {}
  );

  const formattedAmounts = {
    [independentField]: typedValue,
    [dependentField]: noLiquidity ? otherTypedValue : parsedAmounts[dependentField]?.toSignificant(6) ?? ''
  };

  const { ethereum } = (window as any);

  const isnotMatic = ethereum && ethereum.isMetaMask && Number(ethereum.chainId) !== 137;
  const toggleWalletModal = useWalletModalToggle();
  const [approvalA, approveACallback] = useApproveCallback(parsedAmounts[Field.CURRENCY_A], ROUTER_ADDRESS);
  const [approvalB, approveBCallback] = useApproveCallback(parsedAmounts[Field.CURRENCY_B], ROUTER_ADDRESS);

  const currencyA = currencies[Field.CURRENCY_A];
  const currencyB = currencies[Field.CURRENCY_B];

  const oneCurrencyIsWETH = Boolean(
    chainId &&
      ((currencyA && currencyEquals(currencyA, WETH[chainId])) ||
        (currencyB && currencyEquals(currencyB, WETH[chainId])))
  )

  const handleCurrencyASelect = useCallback(
    (currencyA: Currency) => {
      onCurrencySelection(Field.CURRENCY_A, currencyA);
    },
    [onCurrencySelection]
  )
  
  const handleCurrencyBSelect = useCallback(
    (currencyB: Currency) => {
      onCurrencySelection(Field.CURRENCY_B, currencyB);
    },
    [onCurrencySelection]
  )

  useEffect(() => {
    onCurrencySelection(Field.CURRENCY_A, Token.ETHER);
    const quickToken = Object.values(allTokens).find((val) => val.symbol === 'QUICK');
    if (quickToken) {
      onCurrencySelection(Field.CURRENCY_B, quickToken);
    }
  }, [onCurrencySelection, allTokens]);

  const onAdd = () => {
    if (expertMode) {
      onAddLiquidity();
    } else {
      setShowConfirm(true);
    }
  }

  const onAddLiquidity = async () => {
    if (!chainId || !library || !account) return
    const router = getRouterContract(chainId, library, account)

    const { [Field.CURRENCY_A]: parsedAmountA, [Field.CURRENCY_B]: parsedAmountB } = parsedAmounts
    if (!parsedAmountA || !parsedAmountB || !currencies[Field.CURRENCY_A] || !currencies[Field.CURRENCY_B] || !deadline) {
      return
    }

    const amountsMin = {
      [Field.CURRENCY_A]: calculateSlippageAmount(parsedAmountA, noLiquidity ? 0 : allowedSlippage)[0],
      [Field.CURRENCY_B]: calculateSlippageAmount(parsedAmountB, noLiquidity ? 0 : allowedSlippage)[0]
    }

    let estimate,
      method: (...args: any) => Promise<TransactionResponse>,
      args: Array<string | string[] | number>,
      value: BigNumber | null
    if (currencies[Field.CURRENCY_A] === ETHER || currencies[Field.CURRENCY_B] === ETHER) {
      const tokenBIsETH = currencies[Field.CURRENCY_B] === ETHER
      estimate = router.estimateGas.addLiquidityETH
      method = router.addLiquidityETH
      args = [
        wrappedCurrency(tokenBIsETH ? currencies[Field.CURRENCY_A] : currencies[Field.CURRENCY_B], chainId)?.address ?? '', // token
        (tokenBIsETH ? parsedAmountA : parsedAmountB).raw.toString(), // token desired
        amountsMin[tokenBIsETH ? Field.CURRENCY_A : Field.CURRENCY_B].toString(), // token min
        amountsMin[tokenBIsETH ? Field.CURRENCY_B : Field.CURRENCY_A].toString(), // eth min
        account,
        deadline.toHexString()
      ]
      value = BigNumber.from((tokenBIsETH ? parsedAmountB : parsedAmountA).raw.toString())
    } else {
      estimate = router.estimateGas.addLiquidity
      method = router.addLiquidity
      args = [
        wrappedCurrency(currencies[Field.CURRENCY_A], chainId)?.address ?? '',
        wrappedCurrency(currencies[Field.CURRENCY_B], chainId)?.address ?? '',
        parsedAmountA.raw.toString(),
        parsedAmountB.raw.toString(),
        amountsMin[Field.CURRENCY_A].toString(),
        amountsMin[Field.CURRENCY_B].toString(),
        account,
        deadline.toHexString()
      ]
      value = null
    }

    setAttemptingTxn(true)
    await estimate(...args, value ? { value } : {})
      .then(estimatedGasLimit =>
        method(...args, {
          ...(value ? { value } : {}),
          gasLimit: calculateGasMargin(estimatedGasLimit)
        }).then(response => {
          setAttemptingTxn(false)

          addTransaction(response, {
            summary:
              'Add ' +
              parsedAmounts[Field.CURRENCY_A]?.toSignificant(3) +
              ' ' +
              currencies[Field.CURRENCY_A]?.symbol +
              ' and ' +
              parsedAmounts[Field.CURRENCY_B]?.toSignificant(3) +
              ' ' +
              currencies[Field.CURRENCY_B]?.symbol
          })

          setTxHash(response.hash)

          ReactGA.event({
            category: 'Liquidity',
            action: 'Add',
            label: [currencies[Field.CURRENCY_A]?.symbol, currencies[Field.CURRENCY_B]?.symbol].join('/')
          })
        })
      )
      .catch(error => {
        setAttemptingTxn(false)
        // we only care if the error is something _other_ than the user rejected the tx
        if (error?.code !== 4001) {
          console.error(error)
        }
      })
  }

  const connectWallet = () => {
    if (isnotMatic) {
      addMaticToMetamask();
    } else {
      toggleWalletModal();
    }
  }

  const handleDismissConfirmation = useCallback(() => {
    setShowConfirm(false)
    // if there was a tx hash, we want to clear the input
    if (txHash) {
      onFieldAInput('')
    }
    setTxHash('')
  }, [onFieldAInput, txHash])

  const modalHeader = () => {
    return noLiquidity ? (
      <Box>
        <Typography>
          {currencies[Field.CURRENCY_A]?.symbol + '/' + currencies[Field.CURRENCY_B]?.symbol}
        </Typography>
        {/* <DoubleCurrencyLogo
          currency0={currencies[Field.CURRENCY_A]}
          currency1={currencies[Field.CURRENCY_B]}
          size={30}
        /> */}
      </Box>
    ) : (
      <Box>
        <Box>
          <Typography>
            {liquidityMinted?.toSignificant(6)}
          </Typography>
          {/* <DoubleCurrencyLogo
            currency0={currencies[Field.CURRENCY_A]}
            currency1={currencies[Field.CURRENCY_B]}
            size={30}
          /> */}
        </Box>
        <Box>
          <Typography>
            {currencies[Field.CURRENCY_A]?.symbol + '/' + currencies[Field.CURRENCY_B]?.symbol + ' Pool Tokens'}
          </Typography>
        </Box>
        <Typography>
          {`Output is estimated. If the price changes by more than ${allowedSlippage /
            100}% your transaction will revert.`}
        </Typography>
      </Box>
    )
  }

  const modalBottom = () => {
    return (
      <ConfirmAddModalBottom
        price={price}
        currencies={currencies}
        parsedAmounts={parsedAmounts}
        noLiquidity={noLiquidity}
        onAdd={onAdd}
        poolTokenPercentage={poolTokenPercentage}
      />
    )
  }

  return (
    <Box>
      <TransactionConfirmationModal
        isOpen={showConfirm}
        onDismiss={handleDismissConfirmation}
        attemptingTxn={attemptingTxn}
        hash={txHash}
        content={() => (
          <ConfirmationModalContent
            title={noLiquidity ? 'You are creating a pool' : 'You will receive'}
            onDismiss={handleDismissConfirmation}
            topContent={modalHeader}
            bottomContent={modalBottom}
          />
        )}
        pendingText={pendingText}
      />
      <CurrencyInput title='Input 1:' currency={currencies[Field.CURRENCY_A]} onMax={() => onFieldAInput(maxAmounts[Field.CURRENCY_A]?.toExact() ?? '')} handleCurrencySelect={handleCurrencyASelect} amount={formattedAmounts[Field.CURRENCY_A]} setAmount={onFieldAInput} />
      <Box className={classes.exchangeSwap}>
        <AddIcon />
      </Box>
      <CurrencyInput title='Input 2:' currency={currencies[Field.CURRENCY_B]} onMax={() => onFieldBInput(maxAmounts[Field.CURRENCY_B]?.toExact() ?? '')} handleCurrencySelect={handleCurrencyBSelect} amount={formattedAmounts[Field.CURRENCY_B]} setAmount={onFieldBInput} />
      {
        currencies[Field.CURRENCY_A] && currencies[Field.CURRENCY_B] && pairState !== PairState.INVALID && price &&
          <Box className={classes.swapPrice}>
            <Typography>1 { currencies[Field.CURRENCY_A]?.symbol } = { price.toSignificant(3) } { currencies[Field.CURRENCY_B]?.symbol } </Typography>
            <Typography>1 { currencies[Field.CURRENCY_B]?.symbol } = { price.invert().toSignificant(3) } { currencies[Field.CURRENCY_A]?.symbol } </Typography>
          </Box>
      }
      <Box className={classes.swapButtonWrapper}>
        {(approvalA === ApprovalState.NOT_APPROVED ||
          approvalA === ApprovalState.PENDING ||
          approvalB === ApprovalState.NOT_APPROVED ||
          approvalB === ApprovalState.PENDING) &&
          !error && (
            <Box className={classes.approveButtons}>
              {approvalA !== ApprovalState.APPROVED && (
                <Box width={approvalB !== ApprovalState.APPROVED ? '48%' : '100%'}>
                  <Button
                    color='primary'
                    onClick={approveACallback}
                    disabled={approvalA === ApprovalState.PENDING}
                  >
                    {approvalA === ApprovalState.PENDING ? (
                      `Approving ${currencies[Field.CURRENCY_A]?.symbol}`
                    ) : (
                      'Approve ' + currencies[Field.CURRENCY_A]?.symbol
                    )}
                  </Button>
                </Box>
              )}
              {approvalB !== ApprovalState.APPROVED && (
                <Box width={approvalA !== ApprovalState.APPROVED ? '48%' : '100%'}>
                  <Button
                    color='primary'
                    onClick={approveBCallback}
                    disabled={approvalB === ApprovalState.PENDING}
                  >
                    {approvalB === ApprovalState.PENDING ? (
                      `Approving ${currencies[Field.CURRENCY_B]?.symbol}`
                    ) : (
                      'Approve ' + currencies[Field.CURRENCY_B]?.symbol
                    )}
                  </Button>
                </Box>
              )}
            </Box>
          )}
        <Button color='primary' disabled={Boolean(account) && (Boolean(error) || approvalA !== ApprovalState.APPROVED || approvalB !== ApprovalState.APPROVED)} onClick={account ? onAdd : connectWallet}>
          { account ? error ?? 'Supply' : 'Connect Wallet' }
        </Button>

        {pair && !noLiquidity && pairState !== PairState.INVALID ? (
          <MinimalPositionCard showUnwrapped={oneCurrencyIsWETH} pair={pair} />
        ) : null}
      </Box>
    </Box>
  )
}

export default AddLiquidity;
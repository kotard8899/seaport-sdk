import defaultAddresses from "./addresses.json";
import { constants } from "ethers";
import { Seaport__factory } from "./factories";
import {
  approveAsset,
  getApprovalStatus,
  getWrappedNativeToken,
  randomHex,
  toBN,
  toKey,
  getOrderHash,
  convertSignatureToEIP2098,
  parseEther,
  getBasicOrderParameters,
  signOrder,
  getFulfillment,
  getFulFillmentArrByOrder,
  getOfferOrConsiderationItem,
} from "./utils/pure";

class SDK {
  // RPC provider from ethers
  provider;
  // Wallet signer
  signer;
  // Chain Id for this instance.
  chainId;
  marketplaceContract;

  /**
   * @param provider Provider from ethers
   * @param {object} [signer] signer from ethers
   * @param {string|number} [chainId] chainId || networkId
   * @returns
   */
  constructor(provider, signer, chainId) {
    this.provider = provider;
    this.signer = signer ?? provider.getSigner();
    this.chainId = chainId
      ? typeof chainId === "string" && chainId.includes("0x")
        ? parseInt(chainId, 16)
        : parseInt(chainId.toString(10), 10)
      : provider._network.chainId;

    this.marketplaceContract = Seaport__factory.connect(
      defaultAddresses[this.chainId.toString(10)].seaport ?? null,
      signer ?? provider
    );
  }

  /**
   * Checks if an asset is approved for trading with Seaport
   * If an asset is not approved, call approveTokenOrNftByAsset to approve.
   * @param {Object} asset A tradeable asset (ERC20, ERC721, or ERC1155)
   * @param {number} asset.itemType REQUIRED: Type of asset
   * @param {string} [asset.token] Token Address of asset
   * @param {string|number} [asset.tokenId] Only needed when checking ERC721
   * @param walletAddress The wallet address that owns the asset
   * @returns
   */
  loadApprovalStatus = async (asset, walletAddress) => {
    return getApprovalStatus(
      walletAddress,
      this.marketplaceContract.address,
      asset,
      this.provider
    );
  };

  /**
   * Function to approve an asset (ERC20, ERC721, or ERC1155) for trading
   * @param asset
   * @param approvalTransactionOverrides
   * @param otherOverrides
   * @returns An ethers contract transaction
   */
  approveAsset = async (
    asset,
    approvalTransactionOverrides,
    otherOverrides
  ) => {
    const signerToUse = otherOverrides?.signer ?? this.signer;
    if (!signerToUse) {
      throw new Error("Signer not defined");
    }
    return approveAsset(
      this.marketplaceContract.address, // todo: opensea現在似乎都是用forwarder
      asset,
      signerToUse,
      {
        ...approvalTransactionOverrides,
      },
      otherOverrides
    );
  };

  /**
   * Create an Order
   * @param offer Transaction hash to await
   * @param consideration Transaction hash to await
   * @param orderType 0 ~ 3
   *  // 0: no partial fills, anyone can execute
   *  FULL_OPEN,
   *  // 1: partial fills supported, anyone can execute
   *  PARTIAL_OPEN,
   *  // 2: no partial fills, only offerer or zone can execute
   *  FULL_RESTRICTED,
   *  // 3: partial fills supported, only offerer or zone can execute
   *  PARTIAL_RESTRICTED
   *
   * @param startTime Timestamp in "seconds"
   * @param endTime Timestamp in "seconds", default expired in 31days (1 month)
   * @param zone Address that can execute RESTRICTED order
   * @param zoneHash The hash to provide upon calling the zone.
   * @param conduitKey   The conduit key used to deploy the conduit. Note that
   *                     the first twenty bytes of the conduit key must match
   *                     the caller of this contract.
   * @param extraCheap
   * @returns
   */
  createOrder = async (
    offer,
    consideration,
    orderType = 0,
    startTime = Math.floor(Date.now() / 1000),
    endTime = startTime + 2678400, // default: 31 days
    // criteriaResolvers,
    zone = constants.AddressZero,
    zoneHash = constants.HashZero,
    conduitKey = constants.HashZero,
    extraCheap = false
  ) => {
    const offerer = this.signer;
    const marketplaceContract = this.marketplaceContract;
    const offerAddress = await offerer.getAddress();
    const counter = await marketplaceContract.getCounter(offerAddress);

    const salt = !extraCheap ? randomHex() : constants.HashZero;

    const orderParameters = {
      offerer: offerAddress,
      zone: !extraCheap ? zone : constants.AddressZero,
      offer,
      consideration,
      totalOriginalConsiderationItems: consideration.length,
      orderType,
      zoneHash,
      salt,
      conduitKey,
      startTime,
      endTime,
    };

    const orderComponents = {
      ...orderParameters,
      counter,
    };
    const orderHash = await getOrderHash(marketplaceContract, orderComponents);

    const { isValidated, isCancelled, totalFilled, totalSize } =
      await marketplaceContract.getOrderStatus(orderHash);

    // expect(isCancelled).to.equal(false);

    const orderStatus = {
      isValidated,
      isCancelled,
      totalFilled,
      totalSize,
    };

    const flatSig = await signOrder(
      marketplaceContract,
      this.chainId,
      orderComponents,
      offerer
    );

    const order = {
      parameters: orderParameters,
      signature: !extraCheap ? flatSig : convertSignatureToEIP2098(flatSig),
      numerator: 1, // only used for advanced orders
      denominator: 1, // only used for advanced orders
      extraData: "0x", // only used for advanced orders
    };

    // How much ether (at most) needs to be supplied when fulfilling the order
    const value = offer
      .map((x) =>
        x.itemType === 0
          ? x.endAmount.gt(x.startAmount)
            ? x.endAmount
            : x.startAmount
          : toBN(0)
      )
      .reduce((a, b) => a.add(b), toBN(0))
      .add(
        consideration
          .map((x) =>
            x.itemType === 0
              ? x.endAmount.gt(x.startAmount)
                ? x.endAmount
                : x.startAmount
              : toBN(0)
          )
          .reduce((a, b) => a.add(b), toBN(0))
      );

    return {
      order,
      orderHash,
      value,
      orderStatus,
      orderComponents,
    };
  };

  /**
   * Fulfill function, deciding which fulfill function to use
   * @param order Order to fulfill
   * @param value Value to be sent, get from createOrder
   * @param criteriaResolvers   An array where each element contains a
   *                            reference to a specific offer or
   *                            consideration, a token identifier, and a proof
   *                            that the supplied token identifier is
   *                            contained in the merkle root held by the item
   *                            in question's criteria element. Note that an
   *                            empty criteria indicates that any
   *                            (transferable) token identifier on the token
   *                            in question is valid and that no associated
   *                            proof needs to be supplied.
   *
   * @returns An ethers contract transaction
   */
  fulfillOrder = async (order, value, criteriaResolvers = []) => {
    if (order.counter) {
      throw new Error("Not orderComponents, give me order");
    }
    const { offer, consideration } = order.parameters;

    if (order.numerator || criteriaResolvers.length > 0) {
      return this.marketplaceContract.fulfillAdvancedOrder(
        order,
        criteriaResolvers,
        toKey(0), // fulfillerConduitKey
        constants.AddressZero, // recipient
        {
          value,
        }
      );
    }

    const cnItemType = consideration[0].itemType;
    let isBasic;

    // fulfillBasicOrder條件
    // offer只能有一個 (20 || 721 || 1155)
    // offer為20時，cn的第一項一定要是721 || 1155，且其他項也只能為20
    // offer為721 || 1155時，cn每項的type都要相等，且只能為NATIVE || 20
    // 其餘皆為 fullfillOrder
    if (offer.length === 1) {
      if (offer[0].itemType === 1) {
        if (cnItemType === 2 || cnItemType === 3) {
          isBasic = true;
          for (const { itemType } of consideration.slice(1)) {
            if (itemType === 0 || itemType === 2 || itemType === 3) {
              isBasic = false;
              break;
            }
          }
        }
      } else {
        if (cnItemType === 0 || cnItemType === 1) {
          isBasic = true;
          for (const { itemType } of consideration.slice(1)) {
            if (itemType !== cnItemType) {
              isBasic = false;
              break;
            }
          }
        }
      }
    }

    if (isBasic) {
      const offerItemType = offer[0].itemType;
      const cnItemType = consideration[0].itemType;
      let basicOrderRouteType;

      // 0, // EthForERC721
      // 1, // EthForERC1155
      // 2, // ERC20ForERC721
      // 3, // ERC20ForERC1155
      // 4, // ERC721forERC20
      // 5, // ERC1155forERC20
      if (offerItemType === 1) {
        basicOrderRouteType = cnItemType === 2 ? 4 : 5;
      } else if (offerItemType === 2) {
        basicOrderRouteType = cnItemType === 0 ? 0 : 2;
      } else {
        basicOrderRouteType = cnItemType === 0 ? 1 : 3;
      }
      const basicOrderParameters = getBasicOrderParameters(
        basicOrderRouteType,
        order
      );

      return this.marketplaceContract.fulfillBasicOrder(basicOrderParameters, {
        value,
      });
    }

    return this.marketplaceContract.fulfillOrder(order, toKey(0), { value });
  };

  // fulfillAdvancedOrder

  /**
   * Cancel an arbitrary number of orders. Note that only the offerer
   * or the zone of a given order may cancel it. Once cancelled, the order no longer fillable.
   * Requires a signer
   * @param {object[]|object} orderComponents An array  of an arbitrary number of orderComponents || one orderComponent
   * @returns An ethers contract transaction
   */
  cancelOrders = (orderComponents) => {
    const orderComponentsArr = Array.isArray(orderComponents)
      ? orderComponents
      : [orderComponents];
    orderComponentsArr.forEach(({ counter }) => {
      if (!counter) {
        throw new Error("Not order, Give me orderComponents");
      }
    });
    return this.marketplaceContract.cancel(orderComponentsArr);
  };

  /**
   * @notice Validate an arbitrary number of orders, thereby registering their
   *         signatures as valid and allowing the fulfiller to skip signature
   *         verification on fulfillment. Note that validated orders may still
   *         be unfulfillable due to invalid item amounts or other factors;
   *         callers should determine whether validated orders are fulfillable
   *         by simulating the fulfillment call prior to execution. Also note
   *         that anyone can validate a signed order, but only the offerer can
   *         validate an order without supplying a signature.
   *
   * @param {object[]|object} orders The orders || one order to validate.
   *
   * @return An ethers contract transaction
   */
  validateOrders = async (orders) => {
    const orderArr = Array.isArray(orders) ? orders : [orders];
    orderArr.forEach(({ counter }) => {
      if (counter) throw new Error("Not orderComponents, give me order");
    });
    return this.marketplaceContract.validate(orderArr);
  };

  /**
   * @notice Match an arbitrary number of orders, each with an arbitrary
   *         number of items for offer and consideration along with a set of
   *         fulfillments allocating offer components to consideration
   *         components. Note that this function does not support
   *         criteria-based or partial filling of orders (though filling the
   *         remainder of a partially-filled order is supported).
   *
   * @param order             The order to be match.
   * @param orderToMatch      The order to match.
   * @param gapAsset          The asset for price difference
   * @return An ethers contract transaction
   */
  matchOrders = async (order, orderToMatch, gapAsset) => {
    // 處理fulfillment

    const fArr = getFulFillmentArrByOrder(order, orderToMatch);

    // 這邊先假設只有英式拍賣會出現 gapAsset
    if (gapAsset) {
      fArr[1][1].push([0, 1]);
      order.parameters.consideration.push(gapAsset);
    }

    const fulfillment = getFulfillment(fArr);

    return this.marketplaceContract.matchOrders(
      [order, orderToMatch],
      fulfillment
    );
  };

  /**
   * Looks up the order status for a given orderHash.
   * @param orderHash The order hash in question.
   *
   * @return isValidated A boolean indicating whether the order in question
   *                     has been validated (i.e. previously approved or
   *                     partially filled).
   * @return isCancelled A boolean indicating whether the order in question
   *                     has been cancelled.
   * @return totalFilled The total portion of the order that has been filled
   *                     (i.e. the "numerator").
   * @return totalSize   The total size of the order that is either filled or
   *                     unfilled (i.e. the "denominator").
   */
  getOrderStatus = async (orderHash) => {
    return await this.marketplaceContract.getOrderStatus(orderHash);
  };

  /**
   * Function to get wrapped token address from specific network
   * @param {string|number} [chainId]
   * @returns {string} wrapped token address
   */
  getWrappedTokenAddress = (chainId) => {
    return getWrappedNativeToken(chainId ?? this.chainId);
  };

  /**
   * Function to get all formatted token
   * @param {Object} asset The token asset
   * @param {number} asset.itemType REQUIRED: Type of asset
   * @param {string} [asset.token] Token Address of asset
   * @param {string|number} [asset.startamount] startamount of asset
   * @param {string|number} [asset.endAmount] endAmount of asset
   * @param {string|number} [asset.tokenId] TokenId of asset
   * @param {string} [asset.recipient] recipient of asset
   * @param {string} [asset.root] root of asset
   *
   * @returns formatted NATIVE token
   */
  getItem = (asset) => {
    const {
      itemType,
      token,
      startAmount,
      endAmount,
      tokenId,
      recipient,
      root,
    } = asset;
    switch (itemType) {
      case 0: // NATIVE
        return this.getItemETH(startAmount, endAmount, recipient);
      case 1: // ERC20
        return this.getItem20(token, startAmount, endAmount, recipient);
      case 2: // ERC721
        return this.getItem721(token, tokenId, recipient);
      case 3: // ERC1155
        return this.getItem1155(
          token,
          tokenId,
          startAmount,
          endAmount,
          recipient
        );
      case 4: // ERC721_WITH_CRITERIA
        return this.getItem721WithCriteria(token, root, recipient);
      case 5: // ERC1155_WITH_CRITERIA
        return this.getItem1155WithCriteria(
          token,
          root,
          startAmount,
          endAmount,
          recipient
        );
    }
  };

  /**
   * Function to get formatted NATIVE token
   * @param {string|number} startAmount Amount when start selling
   * @param {string|number} endAmount Amount when end selling
   * @param recipient Address who recieve the amount of NATIVE token
   * @returns formatted NATIVE token
   */
  getItemETH = (startAmount, endAmount = startAmount, recipient) =>
    getOfferOrConsiderationItem(
      0,
      constants.AddressZero,
      0,
      parseEther(String(startAmount)),
      parseEther(String(endAmount)),
      recipient
    );

  /**
   * Function to get formatted ERC20 token
   * @notice  Some ERC20 token like USDC has only 6 decimal places (10^6),
   *          thus 1 usdc should input amount with (1 / 10^12).
   *          This should be handled pretty carefully.
   *
   * @param token Token address
   * @param {string|number} startAmount Amount when start selling
   * @param {string|number} endAmount Amount when end selling
   * @param recipient Address who recieve the amount of ERC20 token
   * @returns formatted ERC20 token
   */
  getItem20 = (token, startAmount, endAmount = startAmount, recipient) =>
    getOfferOrConsiderationItem(
      1,
      token,
      0,
      parseEther(String(startAmount)),
      parseEther(String(endAmount)),
      recipient
    );

  /**
   * Function to get formatted ERC721 token
   * @param token Token address
   * @param {string|number} identifierOrCriteria TokenId
   * @param recipient Address who recieve the amount of ERC20 token
   * @returns formatted ERC721 token
   */
  getItem721 = (token, identifierOrCriteria, recipient) =>
    getOfferOrConsiderationItem(
      2,
      token,
      identifierOrCriteria,
      1,
      1,
      recipient
    );

  /**
   * Function to get formatted ERC721 token with criteria
   * @param token Token address
   * @param {string|number} identifierOrCriteria root of merkleTree
   * @param recipient Address who recieve the amount of ERC20 token
   * @returns formatted ERC721 token with criteria
   */
  getItem721WithCriteria = (token, identifierOrCriteria, recipient) =>
    getOfferOrConsiderationItem(
      4,
      token,
      identifierOrCriteria,
      1,
      1,
      recipient
    );

  /**
   * Function to get formatted ERC1155 token
   * @param token Token address
   * @param {string|number} identifierOrCriteria TokenId
   * @param {string|number} startAmount Amount when start selling
   * @param {string|number} endAmount Amount when end selling
   * @param recipient Address who recieve the amount of ERC1155 token
   * @returns formatted ERC1155 token
   */
  getItem1155 = (
    token,
    identifierOrCriteria,
    startAmount = 1,
    endAmount = startAmount,
    recipient
  ) =>
    getOfferOrConsiderationItem(
      3,
      token,
      identifierOrCriteria,
      startAmount,
      endAmount,
      recipient
    );

  /**
   * Function to get formatted ERC1155 token with criteria
   * @param token Token address
   * @param {string|number} identifierOrCriteria root of merkleTree
   * @param {string|number} startAmount Amount when start selling
   * @param {string|number} endAmount Amount when end selling
   * @param recipient Address who recieve the amount of ERC1155 token
   * @returns formatted ERC1155 token with criteria
   */
  getItem1155WithCriteria = (
    token,
    identifierOrCriteria,
    startAmount = 1,
    endAmount = startAmount,
    recipient
  ) =>
    getOfferOrConsiderationItem(
      5,
      token,
      identifierOrCriteria,
      startAmount,
      endAmount,
      recipient
    );

  buildResolver = (
    orderIndex,
    side, // 0 | 1
    index,
    identifier,
    criteriaProof
  ) => ({
    orderIndex,
    side,
    index,
    identifier,
    criteriaProof,
  });
}

export default SDK;

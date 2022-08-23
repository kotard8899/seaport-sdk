import { randomBytes as nodeRandomBytes } from "crypto";
import { BigNumber, constants, utils } from "ethers";
import defaultAddresses from "./addresses.json";
import { ERC20__factory, ERC721__factory, ERC1155__factory } from "./factories";

const randomBytes = (n) => nodeRandomBytes(n).toString("hex");

const hexRegex = /[A-Fa-fx]/g;

const toHex = (n, numBytes = 0) => {
  const asHexString = BigNumber.isBigNumber(n)
    ? n.toHexString().slice(2)
    : typeof n === "string"
    ? hexRegex.test(n)
      ? n.replace(/0x/, "")
      : Number(n).toString(16)
    : Number(n).toString(16);
  return `0x${asHexString.padStart(numBytes * 2, "0")}`;
};

// Some arbitrarily high number.
const MAX_APPROVAL = BigNumber.from(2).pow(118);

const orderType = {
  OrderComponents: [
    { name: "offerer", type: "address" },
    { name: "zone", type: "address" },
    { name: "offer", type: "OfferItem[]" },
    { name: "consideration", type: "ConsiderationItem[]" },
    { name: "orderType", type: "uint8" },
    { name: "startTime", type: "uint256" },
    { name: "endTime", type: "uint256" },
    { name: "zoneHash", type: "bytes32" },
    { name: "salt", type: "uint256" },
    { name: "conduitKey", type: "bytes32" },
    { name: "counter", type: "uint256" },
  ],
  OfferItem: [
    { name: "itemType", type: "uint8" },
    { name: "token", type: "address" },
    { name: "identifierOrCriteria", type: "uint256" },
    { name: "startAmount", type: "uint256" },
    { name: "endAmount", type: "uint256" },
  ],
  ConsiderationItem: [
    { name: "itemType", type: "uint8" },
    { name: "token", type: "address" },
    { name: "identifierOrCriteria", type: "uint256" },
    { name: "startAmount", type: "uint256" },
    { name: "endAmount", type: "uint256" },
    { name: "recipient", type: "address" },
  ],
};

export const getApprovalStatus = async (
  walletAddress,
  exchangeAddress,
  asset,
  provider
) => {
  switch (asset.itemType) {
    case 0: // NATIVE
      return true;
    case 1: // ERC20
      const erc20 = ERC20__factory.connect(asset.token, provider);
      const erc20AllowanceBigNumber = await erc20.allowance(
        walletAddress,
        exchangeAddress
      );
      // Weird issue with BigNumber and approvals...need to look into it, adding buffer.
      const MAX_APPROVAL_WITH_BUFFER = BigNumber.from(
        MAX_APPROVAL.toString()
      ).sub("100000000000000000");
      const approvedForMax = erc20AllowanceBigNumber.gte(
        MAX_APPROVAL_WITH_BUFFER
      );
      return approvedForMax;
    case 2 || 4: // ERC721 || ERC721_WITH_CRITERIA
      const erc721 = ERC721__factory.connect(asset.token, provider);
      const erc721ApprovalForAllPromise = erc721.isApprovedForAll(
        walletAddress,
        exchangeAddress
      );
      const erc721ApprovedAddressForIdPromise = erc721.getApproved(
        asset.tokenId
      );
      const [erc721ApprovalForAll, erc721ApprovedAddressForId] =
        await Promise.all([
          erc721ApprovalForAllPromise,
          erc721ApprovedAddressForIdPromise,
        ]);
      const tokenIdApproved =
        erc721ApprovedAddressForId.toLowerCase() ===
        exchangeAddress.toLowerCase();
      return erc721ApprovalForAll || tokenIdApproved;
    case 3 || 5: // ERC1155 || ERC1155_WITH_CRITERIA
      const erc1155 = ERC1155__factory.connect(asset.token, provider);
      const erc1155ApprovalForAll = await erc1155.isApprovedForAll(
        walletAddress,
        exchangeAddress
      );
      return erc1155ApprovalForAll ?? false;
    default:
      throw new Error(`Unexpected itemType: ${asset.itemType}`);
  }
};

export const approveAsset = async (
  exchangeProxyAddressForAsset,
  asset,
  signer,
  txOverrides = {},
  approvalOrderrides
) => {
  const approve = approvalOrderrides?.approve ?? true;

  switch (asset.itemType) {
    case 1: // ERC20
      const erc20 = ERC20__factory.connect(asset.token, signer);
      const erc20ApprovalTxPromise = erc20.approve(
        exchangeProxyAddressForAsset,
        approve ? MAX_APPROVAL.toString() : 0,
        {
          ...txOverrides,
        }
      );
      return erc20ApprovalTxPromise;
    case 2 || 4: // ERC721 || ERC721_WITH_CRITERIA
      const erc721 = ERC721__factory.connect(asset.token, signer);
      // If consumer prefers only to approve the tokenId, only approve tokenId
      if (approvalOrderrides?.approvalOnlyTokenIdIfErc721) {
        const erc721ApprovalForOnlyTokenId = erc721.approve(
          exchangeProxyAddressForAsset,
          asset.tokenId,
          {
            ...txOverrides,
          }
        );
        return erc721ApprovalForOnlyTokenId;
      }
      // Otherwise default to approving entire contract
      const erc721ApprovalForAllPromise = erc721.setApprovalForAll(
        exchangeProxyAddressForAsset,
        approve,
        {
          ...txOverrides,
        }
      );
      return erc721ApprovalForAllPromise;
    case 3 || 5: // ERC1155 || ERC1155_WITH_CRITERIA
      const erc1155 = ERC1155__factory.connect(asset.token, signer);
      // ERC1155s can only approval all
      const erc1155ApprovalForAll = await erc1155.setApprovalForAll(
        exchangeProxyAddressForAsset,
        approve,
        {
          ...txOverrides,
        }
      );
      return erc1155ApprovalForAll;
    default:
      throw new Error(`Unexpected itemType: ${asset.itemType}`);
  }
};

export const getWrappedNativeToken = (chainId) => {
  chainId =
    typeof chainId === "string" && chainId.includes("0x")
      ? parseInt(chainId, 16)
      : chainId;
  const chainIdString = chainId.toString(10);
  return defaultAddresses[chainIdString].wrappedNativeToken ?? null;
};

export const { parseEther } = utils;

export const randomHex = (bytes = 32) => `0x${randomBytes(bytes)}`;

export const toBN = (n) => BigNumber.from(toHex(n));

export const toKey = (n) => toHex(n, 32);

export const convertSignatureToEIP2098 = (signature) => {
  if (signature.length === 130) {
    return signature;
  }

  if (signature.length !== 132) {
    throw new Error("invalid signature length (must be 64 or 65 bytes)");
  }

  return utils.splitSignature(signature).compact;
};

export const getOrderHash = async (marketplaceContract, orderComponents) => {
  const orderHash = await marketplaceContract.getOrderHash(orderComponents);
  return orderHash;
};

// Returns signature
export const signOrder = async (
  marketplaceContract,
  chainId,
  orderComponents,
  signer
) => {
  // Required for EIP712 signing
  const domainData = {
    name: "Seaport",
    version: "1.1",
    chainId,
    verifyingContract: marketplaceContract.address,
  };

  const signature = await signer._signTypedData(
    domainData,
    orderType,
    orderComponents
  );

  // const orderHash = await getOrderHash(marketplaceContract, orderComponents);

  // const { domainSeparator } = await marketplaceContract.information();
  // const digest = keccak256(
  //   `0x1901${domainSeparator.slice(2)}${orderHash.slice(2)}`
  // );
  // const recoveredAddress = recoverAddress(digest, signature);

  // expect(recoveredAddress).to.equal(signer.address);

  return signature;
};

export const getOfferOrConsiderationItem = (
  itemType = 0,
  token = constants.AddressZero,
  identifierOrCriteria = 0,
  startAmount = 1,
  endAmount = 1,
  recipient
) => {
  const offerItem = {
    itemType,
    token,
    identifierOrCriteria: toBN(identifierOrCriteria),
    startAmount: toBN(startAmount),
    endAmount: toBN(endAmount),
  };
  if (typeof recipient === "string") {
    return {
      ...offerItem,
      recipient,
    };
  }
  return offerItem;
};

const toFulfillmentComponents = (arr) =>
  arr.map(([orderIndex, itemIndex]) => ({ orderIndex, itemIndex }));

const toFulfillment = (offerArr, considerationsArr) => ({
  offerComponents: toFulfillmentComponents(offerArr),
  considerationComponents: toFulfillmentComponents(considerationsArr),
});

export const getFulfillment = (
  arr = [
    [[[0, 0]], [[1, 0]]],
    [[[1, 0]], [[0, 0]]],
    [[[1, 0]], [[0, 1]]],
    [[[1, 0]], [[0, 2]]],
  ]
) =>
  arr.map(([offerArr, considerationArr]) =>
    toFulfillment(offerArr, considerationArr)
  );

export const getBasicOrderParameters = (
  basicOrderRouteType,
  order,
  fulfillerConduitKey = false,
  tips = []
) => ({
  offerer: order.parameters.offerer,
  zone: order.parameters.zone,
  basicOrderType: order.parameters.orderType + 4 * basicOrderRouteType,
  offerToken: order.parameters.offer[0].token,
  offerIdentifier: order.parameters.offer[0].identifierOrCriteria,
  offerAmount: order.parameters.offer[0].endAmount,
  considerationToken: order.parameters.consideration[0].token,
  considerationIdentifier:
    order.parameters.consideration[0].identifierOrCriteria,
  considerationAmount: order.parameters.consideration[0].endAmount,
  startTime: order.parameters.startTime,
  endTime: order.parameters.endTime,
  zoneHash: order.parameters.zoneHash,
  salt: order.parameters.salt,
  totalOriginalAdditionalRecipients: BigNumber.from(
    order.parameters.consideration.length - 1
  ),
  signature: order.signature,
  offererConduitKey: order.parameters.conduitKey,
  fulfillerConduitKey: toKey(
    typeof fulfillerConduitKey === "string" ? fulfillerConduitKey : 0
  ),
  additionalRecipients: [
    ...order.parameters.consideration
      .slice(1)
      .map(({ endAmount, recipient }) => ({ amount: endAmount, recipient })),
    ...tips,
  ],
});

export const getFulFillmentArrByOrder = (order, orderToMatch) => {
  const { offer, consideration: cn } = order.parameters;
  const { offer: offerToMatch, consideration: cnToMatch } =
    orderToMatch.parameters;
  const fArr = [];

  for (let oI = 0; oI < offer.length; ++oI) {
    const {
      token: oToken,
      itemType: oItemType,
      identifierOrCriteria: oId,
    } = offer[oI];

    for (let cnTMI = 0; cnTMI < cnToMatch.length; ++cnTMI) {
      if (
        oToken !== cnToMatch[cnTMI].token ||
        (oItemType !== 1 &&
          oId.toNumber() !== cnToMatch[cnTMI].identifierOrCriteria.toNumber())
      )
        continue;

      fArr.push([[[0, oI]], [[1, cnTMI]]]);
      if (oItemType !== 1) break;
    }

    if (oItemType !== 1) continue;

    for (let cnI = 0; cnI < cn.length; ++cnI) {
      if (
        oToken !== cn[cnI].token ||
        (oItemType !== 1 &&
          oId.toNumber() !== cn[cnI].identifierOrCriteria.toNumber())
      )
        continue;

      fArr.push([[[0, oI]], [[0, cnI]]]);
      if (oItemType !== 1) break;
    }
  }

  for (let oTMI = 0; oTMI < offerToMatch.length; ++oTMI) {
    const {
      token: oToken,
      itemType: oItemType,
      identifierOrCriteria: oId,
    } = offerToMatch[oTMI];

    for (let cnIn = 0; cnIn < cn.length; ++cnIn) {
      if (
        oToken !== cn[cnIn].token ||
        (oItemType !== 1 &&
          oId.toNumber() !== cn[cnIn].identifierOrCriteria.toNumber())
      )
        continue;

      fArr.push([[[1, oTMI]], [[0, cnIn]]]);

      if (oItemType !== 1) break;
    }

    if (oItemType !== 1) continue;

    for (let cnTMIn = 0; cnTMIn < cnToMatch.length; ++cnTMIn) {
      if (
        oToken !== cnToMatch[cnTMIn].token ||
        (oItemType !== 1 &&
          oId.toNumber() !== cnToMatch[cnTMIn].identifierOrCriteria.toNumber())
      )
        continue;

      fArr.push([[[1, oTMI]], [[1, cnTMIn]]]);

      if (oItemType !== 1) break;
    }
  }

  return fArr;
};

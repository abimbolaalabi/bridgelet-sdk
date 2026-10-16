import { ApiProperty } from '@nestjs/swagger';

/**
 * Response shape for `POST /claims/verify`.
 *
 * Verified for #858: this is an explicit allow-list DTO. It declares only the
 * fields below (`valid`, `accountId`, `amount`, `asset`, `expiresAt`) and is
 * constructed field-by-field in `TokenVerificationProvider`, so neither the
 * raw claim token nor any account secret can leak through this response shape
 * even if the underlying `Account` entity gains new sensitive columns.
 */
export class ClaimVerificationResponseDto {
  @ApiProperty({
    example: true,
    description: 'Whether the claim token is valid and can be redeemed',
  })
  valid: boolean;

  @ApiProperty({
    example: '4ebae33b-5b93-424c-858d-d79afc708af5',
    description: 'The account ID associated with the claim token',
  })
  accountId: string;

  @ApiProperty({
    example: '100.0000000',
    description: 'The amount that can be claimed',
  })
  amount: string;

  @ApiProperty({
    example: 'native',
    description:
      'The asset identifier (e.g., "native" or "USDC:GBUQWP3BOUZX34ULNQG23RQ6F4BFSRXVZ6GM2FYCVJW5M2D4D811E4B2")',
  })
  asset: string;

  @ApiProperty({
    example: '2026-02-21T10:30:00Z',
    description: 'The timestamp when the claim token expires',
  })
  expiresAt: Date;
}

import { describe, expect, test } from 'claude-code/testing'

import {
  BLOCK,
  hasPii,
  isCardNumber,
  isIban,
  isIpv6,
  isSecretName,
  luhn,
  mask,
  parseNameList,
  redactDeep,
  redactText,
} from '../hooks/redact'

const r = (text: string, names: string[] = []) => redactText(text, { names })

/** Asserts `value` is masked with `tag` and gone from the output. */
function masks(text: string, value: string, tag: string | undefined, names: string[] = []): void {
  const out = r(text, names)
  expect(out, `${JSON.stringify(text)} → ${JSON.stringify(out)}`).not.toContain(value)
  expect(out).toContain(mask(tag))
}

/** Asserts the text comes back unchanged. */
function keeps(text: string, names: string[] = []): void {
  expect(r(text, names), text).toBe(text)
}

describe('checksums', () => {
  test('luhn', () => {
    expect(luhn('4111111111111111')).toBe(true)
    expect(luhn('4111111111111112')).toBe(false)
    expect(luhn('79927398713')).toBe(true)
    expect(luhn('12a4')).toBe(false)
  })
  test('card numbers need a network prefix and a valid check digit', () => {
    expect(isCardNumber('4111111111111111')).toBe(true) // Visa
    expect(isCardNumber('5555555555554444')).toBe(true) // Mastercard
    expect(isCardNumber('378282246310005')).toBe(true) // Amex
    expect(isCardNumber('6011111111111117')).toBe(true) // Discover
    expect(isCardNumber('1234567812345670')).toBe(false) // valid Luhn, no network
    expect(isCardNumber('411111111111')).toBe(false) // too short
  })
  test('iban mod 97', () => {
    expect(isIban('GB82 WEST 1234 5698 7654 32')).toBe(true)
    expect(isIban('DE89370400440532013000')).toBe(true)
    expect(isIban('FR1420041010050500013M02606')).toBe(true)
    expect(isIban('GB82 WEST 1234 5698 7654 33')).toBe(false)
    expect(isIban('AB12')).toBe(false)
  })
  test('ipv6 shape', () => {
    expect(isIpv6('2001:0db8:85a3:0000:0000:8a2e:0370:7334')).toBe(true)
    expect(isIpv6('2001:db8::1')).toBe(true)
    expect(isIpv6('12:34:56')).toBe(false)
    expect(isIpv6('1::2::3')).toBe(false)
  })
})

describe('contact', () => {
  test('emails', () => {
    masks('mail jin.song+x@agentsy.ai today', 'jin.song+x@agentsy.ai', 'email')
    masks('<a.b@sub.example.co.uk>', 'a.b@sub.example.co.uk', 'email')
    masks('Co-Authored-By: Someone <someone@example.com>', 'someone@example.com', 'email')
  })
  test('not emails', () => {
    keeps('git@github.com:mrjk05/modemon.git')
    keeps('icon@2x.png and logo@3x.webp')
    keeps('npm i @types/node@20.1.0 and react@latest')
  })
  test('phones', () => {
    masks('call +1 (555) 123-4567 now', '123-4567', 'phone')
    masks('UK +44 20 7946 0958', '7946 0958', 'phone')
    masks('DE +4915112345678', '4915112345678', 'phone')
    masks('FR +33 1 23 45 67 89', '45 67 89', 'phone')
    masks('office 415-555-0123', '415-555-0123', 'phone')
    masks('office 415.555.0123', '415.555.0123', 'phone')
    masks('office (415) 555-0123', '555-0123', 'phone')
    masks('toll free 1-800-555-0199', '800-555-0199', 'phone')
  })
  test('not phones', () => {
    keeps('+12 -3 lines changed')
    keeps('released 2024-10-06, build 20241006.1')
    keeps('at 2024-10-06T12:34:56+05:30')
    keeps('pid 12345 port 8080 epoch 1696543210')
    keeps('uuid 123e4567-e89b-12d3-a456-426614174000')
  })
})

describe('financial', () => {
  test('cards, grouped or not', () => {
    masks('card 4111 1111 1111 1111 exp', '4111 1111 1111 1111', 'card')
    masks('card 4111-1111-1111-1111', '4111-1111-1111-1111', 'card')
    masks('card 4111111111111111', '4111111111111111', 'card')
    masks('amex 3782 822463 10005', '822463', 'card')
  })
  test('not cards', () => {
    keeps('card 4111111111111112') // bad check digit
    keeps('ms 1696543210123') // epoch milliseconds
    keeps('list 4 5 6 7 8 9 1 2 3 4 5 6 7 8')
    keeps('id 12345678901234567890123') // too long
  })
  test('iban', () => {
    masks('pay GB82 WEST 1234 5698 7654 32 please', 'WEST 1234', 'iban')
    masks('pay DE89370400440532013000.', 'DE89370400440532013000', 'iban')
    keeps('pay GB82 WEST 1234 5698 7654 33')
  })
  test('ssn', () => {
    masks('ssn 123-45-6789', '123-45-6789', 'ssn')
    keeps('ssn 000-45-6789 and 666-12-3456 and 123-00-4567')
  })
  test('bank account and sort code after a banking word', () => {
    masks('Account number: 12345678', '12345678', 'bank')
    masks('sort code 12-34-56', '12-34-56', 'bank')
    masks('routing number 021000021', '021000021', 'bank')
    keeps('dated 06-10-24, 12-34-56 apart')
  })
})

describe('secrets', () => {
  test('provider keys', () => {
    masks('ANTHROPIC_API_KEY=sk-ant-api03-abcDEF123456789_xyz-QWERTY', 'sk-ant-api03', 'key')
    masks('key sk-proj-abcdefghij1234567890KLMN', 'sk-proj-abcdefghij', 'key')
    masks('token ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'ghp_', 'key')
    masks('token gho_abcdefghijklmnopqrstuvwxyz0123456789', 'gho_', 'key')
    masks('pat github_pat_11ABCDEFG0123456789_abcdefghijklmnop', 'github_pat_', 'key')
    masks('slack xoxb-1234567890-abcdefghij', 'xoxb-', 'key')
    masks('slack xoxp-1234567890-abcdefghij', 'xoxp-', 'key')
    masks('aws AKIAIOSFODNN7EXAMPLE', 'AKIAIOSFODNN7EXAMPLE', 'key')
    masks('google AIzaSyA1234567890abcdefghijklmnopqrstuv', 'AIzaSy', 'key')
    masks('stripe sk_live_abcdefghijklmnop1234', 'sk_live_', 'key')
  })
  test('not keys', () => {
    keeps('pip install scikit-learn; risk-assessment-for-the-whole-team')
    keeps('the sk-learn package')
  })
  test('jwt', () => {
    masks(
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      'eyJhbGci',
      'jwt',
    )
  })
  test('bearer and basic', () => {
    const out = r('Authorization: Bearer abcdef1234567890xyz')
    expect(out).toBe(`Authorization: Bearer ${mask('token')}`)
    masks('-H "Authorization: Basic dXNlcjpwYXNzd29yZA=="', 'dXNlcjpwYXNzd29yZA==', 'token')
    keeps('the Bearer authentication scheme')
  })
  test('private key blocks keep their line count', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nq83fjZ0\n-----END RSA PRIVATE KEY-----\nafter'
    const out = r(pem)
    expect(out).not.toContain('MIIEowIBAAKCAQEA')
    expect(out).not.toContain('q83fjZ0')
    expect(out).toContain('-----BEGIN RSA PRIVATE KEY-----')
    expect(out).toContain('-----END RSA PRIVATE KEY-----')
    expect(out).toContain(mask('private key'))
    expect(out.split('\n')).toHaveLength(pem.split('\n').length)
    const open = r('-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\nAAAA')
    expect(open).not.toContain('b3BlbnNzaC1rZXk')
    expect(open).not.toContain('AAAA')
  })
  test('env-style and config assignments', () => {
    expect(r('export PASSWORD=hunter2')).toBe(`export PASSWORD=${mask('secret')}`)
    expect(r('DB_PASS="s3cr3t"')).toBe(`DB_PASS="${mask('secret')}"`)
    expect(r('"client_secret": "abc"')).toBe(`"client_secret": "${mask('secret')}"`)
    expect(r("api_key: 'x1'")).toBe(`api_key: '${mask('secret')}'`)
    expect(r('password: hunter22')).toBe(`password: ${mask('secret')}`)
    expect(r('mysql --password=abc12345')).toBe(`mysql --password=${mask('secret')}`)
    expect(r('STRIPE_KEY=abc')).toBe(`STRIPE_KEY=${mask('secret')}`)
    expect(r('const apiKey = "abcd1234"')).toBe(`const apiKey = "${mask('secret')}"`)
  })
  test('assignments that are not secrets', () => {
    keeps('password: string')
    keeps('token: this.token')
    keeps('const token = await getToken()')
    keeps('max_tokens: 4096, input_tokens: 12')
    keeps('API_KEY=${API_KEY} and TOKEN=<your token> and SECRET=***')
    keeps('token_type: "Bearer"')
    keeps('SSH_KEY_PATH=/home/me/.ssh/id_ed25519'.replace('/home/me', '~'))
    keeps('keyboard: "qwerty123", monkey = "banana1"')
    keeps('key: "react-key-1"')
    keeps('PWD=~/code/app')
  })
  test('url credentials', () => {
    expect(r('postgres://admin:pa55word@db.internal:5432/app')).toBe(
      `postgres://admin:${mask('secret')}@db.internal:5432/app`,
    )
    keeps('https://example.com:8443/path')
  })
})

describe('network', () => {
  test('ipv4', () => {
    masks('ssh 192.168.1.10', '192.168.1.10', 'ip')
    masks('http://10.0.0.1:8080/x', '10.0.0.1', 'ip')
    masks('host at 8.8.8.8.', '8.8.8.8', 'ip')
  })
  test('ipv6', () => {
    masks('addr fe80::1ff:fe23:4567:890a', 'fe80::1ff', 'ip')
    masks('addr 2001:0db8:85a3:0000:0000:8a2e:0370:7334', '2001:0db8', 'ip')
  })
  test('not addresses', () => {
    keeps('listening on 127.0.0.1:3000 and 0.0.0.0, mask 255.255.255.0, ::1')
    keeps('node v18.17.1.2 and chrome/120.0.6099.109')
    keeps('std::vector<int> and Foo::Bar and Abc::Def')
    keeps('at 12:34:56 in src/app.ts:12:34')
    keeps('mac aa:bb:cc:dd:ee:ff')
  })
})

describe('paths and names', () => {
  test('home-folder usernames', () => {
    expect(r('/Users/jins/code/app')).toBe(`/Users/${BLOCK}/code/app`)
    expect(r('cd /home/jins')).toBe(`cd /home/${BLOCK}`)
    expect(r('C:\\Users\\jins\\Desktop')).toBe(`C:\\Users\\${BLOCK}\\Desktop`)
    keeps('/Users/Shared/file and /usr/home/x and /var/home')
  })
  test('names on word boundaries, any case, flexible spaces', () => {
    const names = ['Jin Song', 'jins']
    expect(r('Hi Jin Song, jins here. JIN   SONG.', names)).toBe(`Hi ${BLOCK}, ${BLOCK} here. ${BLOCK}.`)
    keeps('jinsong and jins_test and Jinsei', names)
  })
  test('names with regex characters and accents', () => {
    expect(r('ask José (C++ dev) or a.b', ['José', 'C++', 'a.b'])).toBe(`ask ${BLOCK} (${BLOCK} dev) or ${BLOCK}`)
    keeps('aXb', ['a.b'])
  })
  test('parseNameList', () => {
    expect(parseNameList(' Alice ,Bob Smith,, x ,alice')).toEqual(['Bob Smith', 'Alice'])
    expect(parseNameList(undefined)).toEqual([])
  })
})

describe('false positives stay', () => {
  test('shas, versions, timestamps, line:col', () => {
    keeps('commit 3f9a1c2b7d4e5f60718293a4b5c6d7e8f9012345 (HEAD -> main)')
    keeps('abbrev 3f9a1c2 and 1234567')
    keeps('version 1.2.3, 10.0.19041, v2.1.290, ^4.17.21, 1.2.3-beta.4')
    keeps('2024-10-06T12:34:56.789Z and 2024-10-06 12:34:56 and 12:34')
    keeps('src/hooks/redact.ts:120:7 error TS2322')
    keeps('sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08')
    keeps('Took 1234ms, 98.6%, 3.14159, 1e10, 0x7fff5fbff8a8')
  })
  test('markdown and code survive', () => {
    keeps('```ts\nconst x: Record<string, number> = { a: 1 }\n```')
    keeps('| col | val |\n|-----|-----|\n| a   | 1   |')
  })
})

describe('options', () => {
  test('a category can be turned off', () => {
    const text = 'mail a@b.com from 10.0.0.1'
    expect(redactText(text, { categories: { contact: false } })).toContain('a@b.com')
    expect(redactText(text, { categories: { contact: false } })).not.toContain('10.0.0.1')
    expect(redactText(text, { categories: { network: false } })).toContain('10.0.0.1')
  })
  test('names off keeps names', () => {
    expect(redactText('hi Alice', { names: ['Alice'], categories: { names: false } })).toBe('hi Alice')
  })
  test('hasPii', () => {
    expect(hasPii('a@b.com')).toBe(true)
    expect(hasPii('nothing here')).toBe(false)
  })
  test('lines are kept everywhere', () => {
    const text = 'a@b.com\n+1 555 123 4567\n\nPASSWORD=x\n4111 1111 1111 1111\n'
    expect(r(text).split('\n')).toHaveLength(text.split('\n').length)
  })
})

describe('redactDeep', () => {
  test('keeps shape, keys and non-strings', () => {
    const input = {
      type: 'text',
      tool_use_id: 'toolu_1',
      file: { filePath: '/Users/jins/a.txt', content: 'mail a@b.com', numLines: 1, startLine: 1 },
      list: ['ok', 'a@b.com', 3, null, true],
    }
    const out = redactDeep(input)
    expect(out.type).toBe('text')
    expect(out.tool_use_id).toBe('toolu_1')
    expect(out.file.filePath).toBe(`/Users/${BLOCK}/a.txt`)
    expect(out.file.content).toBe(`mail ${mask('email')}`)
    expect(out.file.numLines).toBe(1)
    expect(out.list).toEqual(['ok', mask('email'), 3, null, true])
    expect(Object.keys(out)).toEqual(Object.keys(input))
  })
  test('returns the same object when nothing changes', () => {
    const input = { a: 'plain', b: [1, 'two'] }
    expect(redactDeep(input)).toBe(input)
  })
  test('does not add undefined fields', () => {
    const out = redactDeep({ stdout: 'a@b.com' }) as Record<string, unknown>
    expect(Object.keys(out)).toEqual(['stdout'])
  })
})

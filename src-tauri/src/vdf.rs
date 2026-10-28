//! Minimal parser for Valve's text KeyValues format (`*.vdf`, `*.acf`).

#[derive(Debug, Clone)]
pub enum Vdf {
    Str(String),
    Obj(Vec<(String, Vdf)>),
}

impl Vdf {
    /// Case-insensitive child lookup; Valve files are inconsistent about key casing.
    pub fn get(&self, key: &str) -> Option<&Vdf> {
        match self {
            Vdf::Obj(items) => items
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(key))
                .map(|(_, v)| v),
            Vdf::Str(_) => None,
        }
    }

    pub fn path(&self, keys: &[&str]) -> Option<&Vdf> {
        keys.iter().try_fold(self, |node, key| node.get(key))
    }

    pub fn str(&self, key: &str) -> Option<&str> {
        self.get(key).and_then(Vdf::as_str)
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Vdf::Str(s) => Some(s),
            Vdf::Obj(_) => None,
        }
    }

    pub fn entries(&self) -> &[(String, Vdf)] {
        match self {
            Vdf::Obj(items) => items,
            Vdf::Str(_) => &[],
        }
    }
}

enum Token {
    Open,
    Close,
    Text(String),
}

fn tokenize(src: &str) -> Vec<Token> {
    let mut out = Vec::new();
    let mut chars = src.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            c if c.is_whitespace() => {}
            '{' => out.push(Token::Open),
            '}' => out.push(Token::Close),
            '/' if chars.peek() == Some(&'/') => {
                for c in chars.by_ref() {
                    if c == '\n' {
                        break;
                    }
                }
            }
            '"' => {
                let mut s = String::new();
                while let Some(c) = chars.next() {
                    match c {
                        '"' => break,
                        '\\' => match chars.next() {
                            Some('n') => s.push('\n'),
                            Some('t') => s.push('\t'),
                            Some(other) => s.push(other),
                            None => break,
                        },
                        other => s.push(other),
                    }
                }
                out.push(Token::Text(s));
            }
            first => {
                let mut s = String::from(first);
                while let Some(&c) = chars.peek() {
                    if c.is_whitespace() || c == '{' || c == '}' || c == '"' {
                        break;
                    }
                    s.push(c);
                    chars.next();
                }
                // Platform conditionals like `[$WIN32]` carry no data for us.
                if !s.starts_with('[') {
                    out.push(Token::Text(s));
                }
            }
        }
    }
    out
}

fn parse_obj(tokens: &mut std::iter::Peekable<std::vec::IntoIter<Token>>) -> Vec<(String, Vdf)> {
    let mut items = Vec::new();
    loop {
        let key = match tokens.next() {
            Some(Token::Text(k)) => k,
            Some(Token::Open) => {
                // Malformed input: skip an anonymous block.
                parse_obj(tokens);
                continue;
            }
            Some(Token::Close) | None => return items,
        };
        match tokens.next() {
            Some(Token::Open) => items.push((key, Vdf::Obj(parse_obj(tokens)))),
            Some(Token::Text(v)) => items.push((key, Vdf::Str(v))),
            Some(Token::Close) | None => return items,
        }
    }
}

pub fn parse(src: &str) -> Vdf {
    let mut tokens = tokenize(src).into_iter().peekable();
    Vdf::Obj(parse_obj(&mut tokens))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_nested_and_escapes() {
        let v = parse(
            r#"
            "libraryfolders"
            {
                // comment
                "0" { "path" "C:\\Program Files (x86)\\Steam" "apps" { "570" "123" } }
                "1" { "Path" "D:\\SteamLibrary" }
            }"#,
        );
        let lf = v.get("libraryfolders").unwrap();
        assert_eq!(lf.entries().len(), 2);
        assert_eq!(
            lf.path(&["0", "path"]).unwrap().as_str(),
            Some(r"C:\Program Files (x86)\Steam")
        );
        assert_eq!(lf.path(&["1", "path"]).unwrap().as_str(), Some(r"D:\SteamLibrary"));
        assert_eq!(lf.path(&["0", "apps", "570"]).unwrap().as_str(), Some("123"));
    }
}

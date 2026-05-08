% Sum 1..20 but skip multiples of 3, stop after sum exceeds 50.
s = 0;
for k = 1:20
  if k - 3 * floor(k / 3) == 0
    continue;
  end
  s = s + k;
  if s > 50
    break;
  end
end
disp(s);
disp(k);

% Cell of cell (homogeneous outer, tuple inner — or homogeneous inner).
inner1 = {1, 2};
inner2 = {3, 4};
inner3 = {5, 6};
outer = {inner1, inner2, inner3};
for k = 1:3
  pair = outer{k};
  disp(pair{1});
  disp(pair{2});
end
